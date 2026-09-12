import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { findExistingConnection } from './postgresConnectionContract';
import { PostgresRecoveryRequiredError } from './postgresErrors';
import type { ReadyPrimaryState } from './primaryState';
import { buildCleanupPlan } from './postgresPlans';
import { findCorrelatedRun } from './postgresRuns';
import {
  deleteOperation,
  readOperation,
  transitionOperation,
  type ConnectionOperation,
} from './provisioningJournal';
import type { PlatformConnection } from './postgresContracts';
import type { RunEventSource, WaitOptions } from './runMonitor';

const RUNNER_IMAGE = 'ezenki/deploy-commander-runner:latest';
const STATUS_QUEUED = 0;
const STATUS_RUNNING = 1;
const STATUS_DONE = 2;
const STATUS_FAILED = 3;

export interface ProvisioningRecoveryDeps {
  caller: RPCCaller;
  events: RunEventSource;
  waitForRun: (
    caller: RPCCaller,
    events: RunEventSource,
    runId: string,
    options: WaitOptions,
  ) => Promise<RPC.GetRun>;
  signal: AbortSignal;
  primary: ReadyPrimaryState;
  platform: PlatformConnection;
  /** The active child request, when any. A journal owned by another caller
   * may be recovered but its connection must never be returned to this one. */
  requestedCallerId?: string;
}

export type ProvisioningRecoveryResult =
  | { kind: 'retry' }
  | { kind: 'busy' }
  | { kind: 'connection'; value: RPC.CreateConnection };

/** Call-site adapter for boot/connection mode: recover the persisted journal
 * before the caller generates credentials or starts a new operation. */
export async function recoverJournalOperation(
  deps: ProvisioningRecoveryDeps,
): Promise<ProvisioningRecoveryResult | null> {
  let operation;
  try {
    operation = await readOperation(deps.caller);
  } catch {
    throw recoveryError();
  }
  if (operation === null) return null;
  if (operation.kind !== 'connection') return { kind: 'busy' };
  return recoverProvisioning(deps, operation);
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validLogicalIdentifier(value: unknown, prefix: 'db' | 'pg_user'): value is string {
  const pattern = prefix === 'db' ? /^db_[0-9a-f]{32}$/ : /^pg_user_[0-9a-f]{32}$/;
  return typeof value === 'string' && pattern.test(value);
}

function recoveryError(): PostgresRecoveryRequiredError {
  return new PostgresRecoveryRequiredError();
}

async function runStatus(caller: RPCCaller, runId: string): Promise<number> {
  let result: unknown;
  try {
    result = await caller.getRun(runId);
  } catch {
    throw recoveryError();
  }
  if (!isRecord(result) || !isRecord(result.run) || result.run.id !== runId
    || (result.run.status !== STATUS_QUEUED && result.run.status !== STATUS_RUNNING
      && result.run.status !== STATUS_DONE && result.run.status !== STATUS_FAILED)) {
    throw recoveryError();
  }
  return result.run.status;
}

async function monitoredStatus(
  deps: ProvisioningRecoveryDeps,
  runId: string,
): Promise<number> {
  const status = await runStatus(deps.caller, runId);
  if (status !== STATUS_QUEUED && status !== STATUS_RUNNING) return status;
  let result: unknown;
  try {
    result = await deps.waitForRun(deps.caller, deps.events, runId, { signal: deps.signal });
  } catch (error) {
    if (isRecord(error) && error.status === STATUS_FAILED) return STATUS_FAILED;
    throw recoveryError();
  }
  if (!isRecord(result) || !isRecord(result.run) || result.run.id !== runId
    || (result.run.status !== STATUS_DONE && result.run.status !== STATUS_FAILED)) {
    throw recoveryError();
  }
  return result.run.status;
}

async function existingConnection(
  deps: ProvisioningRecoveryDeps,
  operation: ConnectionOperation,
): Promise<RPC.CreateConnection | null> {
  try {
    return await findExistingConnection(deps.caller, operation.callerId, operation.resourceId, deps.platform);
  } catch {
    throw recoveryError();
  }
}

function connectionBelongsToOperation(
  value: RPC.CreateConnection,
  operation: ConnectionOperation,
): boolean {
  if (!isRecord(value) || !isRecord(value.config) || !isRecord(value.config.metadata)) return false;
  return value.config.metadata.database === operation.database
    && value.config.metadata.username === operation.username;
}

async function clearLock(deps: ProvisioningRecoveryDeps, operation: ConnectionOperation): Promise<void> {
  try {
    await deleteOperation(deps.caller, operation.operationId);
  } catch {
    throw recoveryError();
  }
}

async function cleanupRun(
  deps: ProvisioningRecoveryDeps,
  operation: ConnectionOperation,
): Promise<ProvisioningRecoveryResult> {
  if (operation.phase === 'cleanup-required') {
    try {
      await transitionOperation(deps.caller, operation.operationId, 'cleanup-required', 'cleanup-starting');
    } catch {
      throw recoveryError();
    }
  }

  let cleanupRunId = operation.cleanupRunId;
  if (!cleanupRunId) {
    const note = `postgres-cleanup:${operation.operationId}`;
    let started: unknown;
    try {
      started = await deps.caller.start(
        'cleanup-connection', RUNNER_IMAGE,
        buildCleanupPlan(deps.primary, operation.database, operation.username, deps.platform), note,
      );
    } catch {
      const match = await findCorrelatedRun(deps.caller, 'cleanup-connection', note);
      if (match.kind === 'ambiguous') return { kind: 'busy' };
      if (match.kind === 'absent') {
        try {
          await transitionOperation(deps.caller, operation.operationId, 'cleanup-starting', {
            phase: 'cleanup-required', cleanupRunId: null,
          });
        } catch { throw recoveryError(); }
        return { kind: 'busy' };
      }
      cleanupRunId = match.id;
    }
    if (!cleanupRunId && isRecord(started) && nonBlank(started.id)) cleanupRunId = started.id;
    if (!cleanupRunId) {
      const match = await findCorrelatedRun(deps.caller, 'cleanup-connection', note);
      if (match.kind === 'found') cleanupRunId = match.id;
      else if (match.kind === 'ambiguous') return { kind: 'busy' };
      else {
        try {
          await transitionOperation(deps.caller, operation.operationId, 'cleanup-starting', {
            phase: 'cleanup-required', cleanupRunId: null,
          });
        } catch { throw recoveryError(); }
        return { kind: 'busy' };
      }
    }
    try {
      await transitionOperation(deps.caller, operation.operationId, 'cleanup-starting', {
        phase: 'cleanup-running', cleanupRunId,
      });
    } catch {
      // A failed CAS is safe to reconcile through the recorded run below.
    }
  }

  // A transport/database/monitoring error does not prove that the cleanup
  // run failed. Keep cleanup-running and its exact run id so a retry can
  // resume monitoring instead of launching a second cleanup runner.
  const status = await monitoredStatus(deps, cleanupRunId);
  if (status === STATUS_FAILED) {
    try {
      await transitionOperation(deps.caller, operation.operationId, 'cleanup-running', {
        phase: 'cleanup-required', cleanupRunId: null,
      });
    } catch { throw recoveryError(); }
    return { kind: 'busy' };
  }
  await clearLock(deps, operation);
  return { kind: 'retry' };
}

async function moveProvisionToCleanup(
  deps: ProvisioningRecoveryDeps,
  operation: ConnectionOperation,
  failed = false,
): Promise<ProvisioningRecoveryResult> {
  try {
    if (failed && operation.phase === 'provision-running') {
      await transitionOperation(deps.caller, operation.operationId, 'provision-running', {
        phase: 'cleanup-required', cleanupReason: operation.cleanupReason ?? 'provision-failed',
      });
      return cleanupRun(deps, { ...operation, phase: 'cleanup-required', cleanupRunId: null });
    } else if (operation.phase === 'provision-running') {
      await transitionOperation(deps.caller, operation.operationId, 'provision-running', 'provisioned');
      await transitionOperation(deps.caller, operation.operationId, 'provisioned', 'persisting');
      await transitionOperation(deps.caller, operation.operationId, 'persisting', 'reconciliation-required');
    } else if (operation.phase === 'provisioned') {
      await transitionOperation(deps.caller, operation.operationId, 'provisioned', 'persisting');
      await transitionOperation(deps.caller, operation.operationId, 'persisting', 'reconciliation-required');
    } else if (operation.phase === 'persisting') {
      await transitionOperation(deps.caller, operation.operationId, 'persisting', 'reconciliation-required');
    }
    await transitionOperation(deps.caller, operation.operationId, 'reconciliation-required', {
      phase: 'cleanup-required', cleanupReason: operation.cleanupReason ?? 'provision-failed',
    });
  } catch {
    throw recoveryError();
  }
  return cleanupRun({ ...deps }, { ...operation, phase: 'cleanup-required', cleanupRunId: null });
}

export async function recoverProvisioning(
  deps: ProvisioningRecoveryDeps,
  operation: ConnectionOperation,
): Promise<ProvisioningRecoveryResult> {
  if (!operation || operation.kind !== 'connection' || !nonBlank(operation.operationId)
    || !nonBlank(operation.callerId) || !nonBlank(operation.resourceId)
    || !validLogicalIdentifier(operation.database, 'db')
    || !validLogicalIdentifier(operation.username, 'pg_user')) throw recoveryError();

  const existing = await existingConnection(deps, operation);
  if (existing) {
    // A stale lock may not be released on the strength of a connection that
    // belongs to a different logical database/role. Keep the lock for its own
    // recovery instead of deleting another operation's journal.
    if (connectionBelongsToOperation(existing, operation)) {
      await clearLock(deps, operation);
      if (deps.requestedCallerId !== undefined && deps.requestedCallerId !== operation.callerId) {
        return { kind: 'busy' };
      }
      return { kind: 'connection', value: existing };
    }
    // A differing connection does not belong to this journal. Continue
    // through the journal's exact run/correlation recovery instead of
    // leaving the operation permanently busy.
  }

  if (operation.phase === 'prepared') {
    await clearLock(deps, operation);
    return { kind: 'retry' };
  }

  if (operation.phase === 'provision-starting') {
    const match = await findCorrelatedRun(deps.caller, 'create-connection', `postgres-provision:${operation.operationId}`);
    if (match.kind === 'ambiguous') return { kind: 'busy' };
    if (match.kind === 'absent') {
      await clearLock(deps, operation);
      return { kind: 'retry' };
    }
    try {
      await transitionOperation(deps.caller, operation.operationId, 'provision-starting', {
        phase: 'provision-running', provisionRunId: match.id,
      });
    } catch {
      throw recoveryError();
    }
    operation = { ...operation, phase: 'provision-running', provisionRunId: match.id };
  }

  if (operation.phase === 'provision-running') {
    if (!operation.provisionRunId) throw recoveryError();
    const status = await runStatus(deps.caller, operation.provisionRunId);
    // A provision run is deliberately left alone while queued/running. A later
    // invocation (or the host's run event) can resume it without compensating
    // against a database that may still be coming up.
    if (status === STATUS_QUEUED || status === STATUS_RUNNING) return { kind: 'busy' };
    return moveProvisionToCleanup(deps, operation, status === STATUS_FAILED);
  }

  if (operation.phase === 'provisioned' || operation.phase === 'persisting' || operation.phase === 'reconciliation-required') {
    if (operation.phase === 'reconciliation-required') {
      try {
        const raced = await findExistingConnection(
          deps.caller, operation.callerId, operation.resourceId, deps.platform,
        );
        if (raced && connectionBelongsToOperation(raced, operation)) {
          await clearLock(deps, operation);
          if (deps.requestedCallerId !== undefined && deps.requestedCallerId !== operation.callerId) {
            return { kind: 'busy' };
          }
          return { kind: 'connection', value: raced };
        }
      } catch { throw recoveryError(); }
    }
    return moveProvisionToCleanup(deps, operation);
  }

  if (operation.phase === 'cleanup-required' || operation.phase === 'cleanup-starting' || operation.phase === 'cleanup-running') {
    if ((operation.phase === 'cleanup-starting' || operation.phase === 'cleanup-running') && !operation.cleanupRunId) {
      const match = await findCorrelatedRun(deps.caller, 'cleanup-connection', `postgres-cleanup:${operation.operationId}`);
      if (match.kind === 'ambiguous') return { kind: 'busy' };
      if (match.kind === 'absent') {
        try {
          await transitionOperation(
            deps.caller, operation.operationId, operation.phase, {
              phase: 'cleanup-required', cleanupRunId: null,
            },
          );
        }
        catch { throw recoveryError(); }
        return { kind: 'busy' };
      }
      try {
        await transitionOperation(deps.caller, operation.operationId, operation.phase, {
          phase: 'cleanup-running', cleanupRunId: match.id,
        });
      } catch {
        throw recoveryError();
      }
      operation = { ...operation, phase: 'cleanup-running', cleanupRunId: match.id };
    }
    return cleanupRun(deps, operation);
  }

  throw recoveryError();
}
