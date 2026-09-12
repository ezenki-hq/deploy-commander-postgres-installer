import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { generateAdminCredentials, type AdminCredentials } from './credentials';
import { buildInstallPlan } from './installPlan';
import { findCorrelatedRun } from './recoverProvisioning';
import { waitForRun, type RunEventSource } from './runMonitor';
import {
  createPrimaryState,
  deletePrimaryState,
  findPrimaryResource,
  readPrimaryState,
  transitionPrimaryState,
  type PrimaryState,
} from './primaryState';
import {
  acquireOperation,
  deleteOperation,
  readOperation,
  transitionOperation,
  type TeardownOperation,
} from './provisioningJournal';
import { OperationBusyError } from './postgresErrors';
import { clearPermission } from './permissionPreference';

const RUNNER_IMAGE = 'ezenki/deploy-commander-runner:latest';
const RUN_FAILED = 3;
const START_ERROR = 'Unable to start PostgreSQL lifecycle run';
const INSTALL_ERROR = 'PostgreSQL installation failed';
const TEARDOWN_ERROR = 'PostgreSQL teardown failed';

export interface InstallationWorkflowDeps {
  caller: RPCCaller;
  events: RunEventSource;
  waitForRun?: typeof waitForRun;
  signal: AbortSignal;
  generateCredentials?: () => AdminCredentials;
  managerId?: string;
  storage?: Storage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function operationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('Secure lifecycle identifiers are unavailable');
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('PostgreSQL lifecycle operation aborted');
  error.name = 'AbortError';
  throw error;
}

function startId(value: unknown): string | null {
  return isRecord(value) && nonBlank(value.id) ? value.id : null;
}

async function acceptedRunId(
  caller: RPCCaller,
  action: string,
  note: string,
  start: () => Promise<unknown>,
): Promise<string> {
  let response: unknown;
  try {
    response = await start();
  } catch {
    const match = await findCorrelatedRun(caller, action, note);
    if (match.kind === 'found') return match.id;
    throw new Error(START_ERROR);
  }
  const id = startId(response);
  if (id) return id;
  const match = await findCorrelatedRun(caller, action, note);
  if (match.kind === 'found') return match.id;
  throw new Error(START_ERROR);
}

function primaryState(operation: string, credentials: AdminCredentials): PrimaryState {
  const now = new Date().toISOString();
  return {
    phase: 'install-prepared', operationId: operation, credentials,
    runId: null, resourceId: null, initializedAt: null, updatedAt: now,
  };
}

export async function installPostgres(deps: InstallationWorkflowDeps): Promise<void> {
  throwIfAborted(deps.signal);
  const existingResource = await findPrimaryResource(deps.caller);
  const existingState = await readPrimaryState(deps.caller);
  const existingOperation = await readOperation(deps.caller);
  if (existingOperation) throw new OperationBusyError();
  if (existingResource) throw new Error('PostgreSQL installation already exists; teardown is required');
  if (existingState) throw new Error('PostgreSQL installation requires recovery');

  const credentials = (deps.generateCredentials ?? generateAdminCredentials)();
  const operation = operationId();
  const state = primaryState(operation, credentials);
  buildInstallPlan(credentials);
  await createPrimaryState(deps.caller, state);
  const note = `postgres-install:${operation}`;
  let runId: string;
  try {
    runId = await acceptedRunId(deps.caller, 'create', note, () => deps.caller.start(
      'create', RUNNER_IMAGE, buildInstallPlan(credentials), note,
    ));
  } catch (error) {
    // An ambiguous start is deliberately retained for boot recovery. A
    // proven absence is safe to remove because no runner was accepted.
    if ((error as Error).message === START_ERROR) {
      const match = await findCorrelatedRun(deps.caller, 'create', note).catch(() => ({ kind: 'ambiguous' as const }));
      if (match.kind === 'absent') await deletePrimaryState(deps.caller, operation).catch(() => undefined);
    }
    throw error;
  }
  try {
    await transitionPrimaryState(deps.caller, operation, 'install-prepared', {
      phase: 'install-running', runId,
    });
  } catch {
    throw new Error('PostgreSQL installation requires recovery');
  }
  throwIfAborted(deps.signal);

  try {
    await (deps.waitForRun ?? waitForRun)(deps.caller, deps.events, runId, { signal: deps.signal });
  } catch (error) {
    if (isRecord(error) && error.name === 'AbortError') throw error;
    if (isRecord(error) && error.status === RUN_FAILED) {
      try {
        // A confirmed runner failure means the installation did not complete.
        // Remove the private record so the manager can safely offer install again.
        await deletePrimaryState(deps.caller, operation);
      } catch {
        throw new Error('PostgreSQL installation requires recovery');
      }
    }
    throw new Error(INSTALL_ERROR);
  }

  // Runner completion is not enough: the resource must be visible before the
  // private state can become ready. A temporary absence remains recoverable.
  const resource = await findPrimaryResource(deps.caller);
  if (!resource) throw new Error('PostgreSQL installation requires recovery');
  try {
    await transitionPrimaryState(deps.caller, operation, 'install-running', {
      phase: 'ready', runId, resourceId: resource.id, initializedAt: new Date().toISOString(),
    });
  } catch {
    throw new Error('PostgreSQL installation requires recovery');
  }
}

function teardownPlan() {
  return { remove_services: ['postgres'], remove_volumes: ['postgres-data'] };
}

function makeTeardownOperation(resourceId: string): TeardownOperation {
  const now = new Date().toISOString();
  return { kind: 'teardown', operationId: operationId(), resourceId, phase: 'teardown-starting', teardownRunId: null, createdAt: now, updatedAt: now };
}

export async function teardownPostgres(
  deps: InstallationWorkflowDeps,
  expectedResource: RPC.ResourceItem,
): Promise<void> {
  throwIfAborted(deps.signal);
  if (!expectedResource || expectedResource.type !== 'postgres' || expectedResource.name !== 'postgres' || expectedResource.external !== false || !nonBlank(expectedResource.id)) {
    throw new Error('Invalid PostgreSQL resource');
  }
  const current = await findPrimaryResource(deps.caller);
  if (!current || current.id !== expectedResource.id) throw new Error('PostgreSQL resource changed; recovery is required');
  const state = await readPrimaryState(deps.caller);
  if (state && state.phase !== 'ready' && state.phase !== 'teardown-failed') throw new Error('PostgreSQL installation requires recovery');
  if (state && state.resourceId !== expectedResource.id) throw new Error('PostgreSQL resource changed; recovery is required');

  const operation = makeTeardownOperation(expectedResource.id);
  await acquireOperation(deps.caller, operation);
  const note = `postgres-teardown:${operation.operationId}`;
  let runId: string;
  try {
    runId = await acceptedRunId(deps.caller, 'teardown', note, () => deps.caller.start(
      'teardown', RUNNER_IMAGE, teardownPlan(), note,
    ));
  } catch (error) {
    const match = await findCorrelatedRun(deps.caller, 'teardown', note).catch(() => ({ kind: 'ambiguous' as const }));
    if (match.kind === 'absent') {
      try {
        await transitionOperation(deps.caller, operation.operationId, 'teardown-starting', 'teardown-release-required');
        await deleteOperation(deps.caller, operation.operationId);
      } catch {
        throw new Error('PostgreSQL lifecycle recovery is required');
      }
    }
    throw error;
  }
  try {
    await transitionOperation(deps.caller, operation.operationId, 'teardown-starting', { phase: 'teardown-running', teardownRunId: runId });
    if (state) await transitionPrimaryState(deps.caller, state.operationId, state.phase, { phase: 'teardown-running', runId: null, resourceId: state.resourceId, initializedAt: state.initializedAt });
  } catch {
    throw new Error('PostgreSQL teardown requires recovery');
  }
  try {
    await (deps.waitForRun ?? waitForRun)(deps.caller, deps.events, runId, { signal: deps.signal });
  } catch (error) {
    if (isRecord(error) && error.name === 'AbortError') throw error;
    if (isRecord(error) && error.status === RUN_FAILED && state) {
      await transitionPrimaryState(deps.caller, state.operationId, 'teardown-running', {
        phase: 'teardown-failed', runId: null, resourceId: state.resourceId, initializedAt: state.initializedAt,
      });
      await transitionOperation(deps.caller, operation.operationId, 'teardown-running', 'teardown-release-required');
      await releaseOperation(deps.caller, operation.operationId);
    }
    throw new Error(TEARDOWN_ERROR);
  }

  if (state) await deletePrimaryState(deps.caller, state.operationId);
  if (deps.storage && deps.managerId && !clearPermission(deps.storage, deps.managerId, expectedResource.id)) {
    throw new Error('PostgreSQL lifecycle recovery is required');
  }
  await transitionOperation(deps.caller, operation.operationId, 'teardown-running', 'teardown-release-required');
  await releaseOperation(deps.caller, operation.operationId);
}

export type LifecycleRecoveryResult = { kind: 'busy' | 'retry' };

function lifecycleRecoveryError(): Error {
  return new Error('PostgreSQL lifecycle recovery is required');
}

async function releaseOperation(caller: RPCCaller, operationId: string): Promise<void> {
  try {
    await deleteOperation(caller, operationId);
  } catch {
    throw lifecycleRecoveryError();
  }
}

async function exactStatus(caller: RPCCaller, runId: string): Promise<number> {
  let result: unknown;
  try { result = await caller.getRun(runId); } catch { throw new Error('PostgreSQL lifecycle recovery is required'); }
  if (!isRecord(result) || !isRecord(result.run) || result.run.id !== runId
    || ![0, 1, 2, 3].includes(result.run.status as number)) {
    throw new Error('PostgreSQL lifecycle recovery is required');
  }
  return result.run.status as number;
}

/** Reconcile a persisted installation state on manager boot. */
export async function recoverInstallationOnBoot(
  deps: InstallationWorkflowDeps,
): Promise<LifecycleRecoveryResult | null> {
  let state = await readPrimaryState(deps.caller);
  if (!state) return null;
  if (state.phase === 'install-prepared') {
    const match = await findCorrelatedRun(deps.caller, 'create', `postgres-install:${state.operationId}`);
    if (match.kind === 'ambiguous') return { kind: 'busy' };
    if (match.kind === 'absent') {
      await deletePrimaryState(deps.caller, state.operationId);
      return { kind: 'retry' };
    }
    await transitionPrimaryState(deps.caller, state.operationId, 'install-prepared', { phase: 'install-running', runId: match.id });
    state = { ...state, phase: 'install-running', runId: match.id };
  }
  if (state.phase === 'install-running') {
    if (!state.runId) throw new Error('PostgreSQL lifecycle recovery is required');
    const status = await exactStatus(deps.caller, state.runId);
    if (status === 0 || status === 1) return { kind: 'busy' };
    if (status === RUN_FAILED) {
      await deletePrimaryState(deps.caller, state.operationId);
      return { kind: 'retry' };
    }
    const resource = await findPrimaryResource(deps.caller);
    if (!resource) return { kind: 'busy' };
    await transitionPrimaryState(deps.caller, state.operationId, 'install-running', {
      phase: 'ready', runId: state.runId, resourceId: resource.id, initializedAt: new Date().toISOString(),
    });
    return { kind: 'retry' };
  }
  if (state.phase === 'install-failed') {
    await deletePrimaryState(deps.caller, state.operationId);
    return { kind: 'retry' };
  }
  return null;
}

/** Reconcile the manager-wide teardown journal without launching a second run. */
export async function recoverTeardownOnBoot(
  deps: InstallationWorkflowDeps,
  managerId = deps.managerId,
  storage = deps.storage,
): Promise<LifecycleRecoveryResult | null> {
  const operation = await readOperation(deps.caller);
  if (!operation || operation.kind !== 'teardown') return null;
  const state = await readPrimaryState(deps.caller);
  let runId = operation.teardownRunId;
  if (operation.phase === 'teardown-starting' && !runId) {
    const match = await findCorrelatedRun(deps.caller, 'teardown', `postgres-teardown:${operation.operationId}`);
    if (match.kind === 'ambiguous') return { kind: 'busy' };
    if (match.kind === 'absent') {
      try {
        await transitionOperation(deps.caller, operation.operationId, 'teardown-starting', 'teardown-release-required');
        await deleteOperation(deps.caller, operation.operationId);
      } catch {
        throw lifecycleRecoveryError();
      }
      return { kind: 'retry' };
    }
    runId = match.id;
    await transitionOperation(deps.caller, operation.operationId, 'teardown-starting', { phase: 'teardown-running', teardownRunId: runId });
    if (state && (state.phase === 'ready' || state.phase === 'teardown-failed')) {
      await transitionPrimaryState(deps.caller, state.operationId, state.phase, { phase: 'teardown-running', resourceId: state.resourceId, initializedAt: state.initializedAt, runId: null });
    }
  }
  if (operation.phase === 'teardown-release-required') {
    // Terminal cleanup has already completed before this phase is written.
    // Only release the journal; never reinterpret the outcome or delete state.
    await releaseOperation(deps.caller, operation.operationId);
    return { kind: 'retry' };
  }
  if (!runId) return { kind: 'busy' };
  const status = await exactStatus(deps.caller, runId);
  if (status === 0 || status === 1) return { kind: 'busy' };
  if (status === RUN_FAILED) {
    if (state?.phase === 'teardown-running') await transitionPrimaryState(deps.caller, state.operationId, 'teardown-running', {
      phase: 'teardown-failed', runId: null, resourceId: state.resourceId, initializedAt: state.initializedAt,
    });
  } else {
    if (state) await deletePrimaryState(deps.caller, state.operationId);
    if (storage && managerId && !clearPermission(storage, managerId, state?.resourceId ?? operation.resourceId)) {
      throw lifecycleRecoveryError();
    }
  }
  await transitionOperation(deps.caller, operation.operationId, 'teardown-running', 'teardown-release-required');
  await releaseOperation(deps.caller, operation.operationId);
  return { kind: 'retry' };
}
