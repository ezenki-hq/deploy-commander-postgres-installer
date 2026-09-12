import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import type { LogicalCredentials } from './credentials';
import { buildCleanupPlan, buildConnectionMetadata, buildProvisionPlan } from './postgresPlans';
import { isPermissionRemembered, rememberPermission } from './permissionPreference';
import {
  acquireOperation,
  deleteOperation,
  transitionOperation,
  type ConnectionOperation,
  type OperationRecord,
} from './provisioningJournal';
import { parsePlatformConnection, type PlatformConnection } from './postgresContracts';
import { PostgresRecoveryRequiredError } from './postgresErrors';
import { findExistingConnection, normalizePostgresConnection } from './postgresConnectionContract';
import { findPrimaryResource, readPrimaryState, type PrimaryState, type ReadyPrimaryState } from './primaryState';
import type { RunEventSource, WaitOptions } from './runMonitor';
import { findCorrelatedRun } from './recoverProvisioning';

export interface ConnectionRequest {
  currentManagerId: string;
  callingManagerId: string;
  resource: RPC.ResourceItem;
  platform: PlatformConnection;
  primary: ReadyPrimaryState;
}

export interface PermissionDecision {
  allowed: boolean;
  remember: boolean;
}

export interface ConnectionWorkflowDeps {
  caller: RPCCaller;
  events: RunEventSource;
  storage: Storage;
  requestPermission: () => Promise<PermissionDecision>;
  generateCredentials: () => LogicalCredentials;
  waitForRun: (
    caller: RPCCaller,
    events: RunEventSource,
    runId: string,
    options: WaitOptions,
  ) => Promise<RPC.GetRun>;
  signal: AbortSignal;
}

const RUNNER_IMAGE = 'ezenki/deploy-commander-runner:latest';
const START_ERROR = 'Unable to start PostgreSQL provisioning';
const RUN_ERROR = 'PostgreSQL provisioning failed';
const PERSIST_ERROR = 'Unable to save the PostgreSQL connection';
const CLEANUP_ERROR = 'Unable to clean up PostgreSQL provisioning';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidTimestamp(value: unknown): value is string {
  return isNonBlank(value) && Number.isFinite(Date.parse(value));
}

function assertRequest(request: ConnectionRequest): PlatformConnection {
  if (!isNonBlank(request.currentManagerId) || !isNonBlank(request.callingManagerId)) {
    throw new Error('A calling manager is required');
  }
  if (!isRecord(request.resource)
    || !isNonBlank(request.resource.id)
    || !isNonBlank(request.resource.type)
    || !isNonBlank(request.resource.name)
    || request.resource.type !== 'postgres'
    || request.resource.name !== 'postgres'
    || request.resource.external !== false) {
    throw new PostgresRecoveryRequiredError();
  }
  if (!isRecord(request.primary)
    || request.primary.phase !== 'ready'
    || !isNonBlank(request.primary.operationId)
    || !isNonBlank(request.primary.runId)
    || !isNonBlank(request.primary.initializedAt)
    || !isRecord(request.primary.credentials)
    || !isNonBlank(request.primary.credentials.username)
    || !isNonBlank(request.primary.credentials.password)
    || !isNonBlank(request.primary.resourceId)
    || request.primary.resourceId !== request.resource.id
    || !isValidTimestamp(request.primary.updatedAt)) {
    throw new PostgresRecoveryRequiredError();
  }
  try {
    return parsePlatformConnection(request.platform);
  } catch {
    throw new PostgresRecoveryRequiredError();
  }
}

function abortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('Connection request aborted', 'AbortError');
  const error = new Error('Connection request aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function operationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('Secure operation identifiers are unavailable');
}

function connectionBelongsToOperation(value: RPC.CreateConnection, operation: ConnectionOperation): boolean {
  return isRecord(value.config) && isRecord(value.config.metadata)
    && value.config.metadata.database === operation.database
    && value.config.metadata.username === operation.username;
}

interface RevalidatedInstallation {
  primary: ReadyPrimaryState;
  resource: RPC.ResourceItem;
  platform: PlatformConnection;
}

/** Read installation identity again after taking the manager-wide lock.
 * The request object is UI input and can be stale while another lifecycle
 * operation changes the resource or manager-owned state. */
async function revalidateInstallation(
  caller: RPCCaller,
  expected: ConnectionRequest,
): Promise<RevalidatedInstallation> {
  let primary: PrimaryState | null;
  let resource: RPC.ResourceItem | null;
  try {
    primary = await readPrimaryState(caller);
    resource = await findPrimaryResource(caller);
  } catch {
    throw new PostgresRecoveryRequiredError();
  }
  if (primary === null || primary.phase !== 'ready'
    || !resource || resource.id !== expected.resource.id
    || primary.resourceId !== resource.id) {
    throw new PostgresRecoveryRequiredError();
  }

  let details: unknown;
  try {
    details = await caller.getResource(resource.id);
  } catch {
    throw new PostgresRecoveryRequiredError();
  }
  if (!isRecord(details) || !isRecord(details.config)
    || !Object.prototype.hasOwnProperty.call(details.config, 'platform_connection')) {
    throw new PostgresRecoveryRequiredError();
  }
  let platform: PlatformConnection;
  try {
    platform = parsePlatformConnection(details.config.platform_connection);
  } catch {
    throw new PostgresRecoveryRequiredError();
  }
  if (!isNonBlank(primary.operationId) || !isNonBlank(primary.runId)
    || !isNonBlank(primary.initializedAt) || !isNonBlank(primary.resourceId)
    || !isNonBlank(primary.updatedAt) || !isNonBlank(primary.credentials.username)
    || !isNonBlank(primary.credentials.password)) {
    throw new PostgresRecoveryRequiredError();
  }
  return { primary: primary as ReadyPrimaryState, resource, platform };
}

function makeOperation(request: ConnectionRequest, credentials: LogicalCredentials): ConnectionOperation {
  const now = new Date().toISOString();
  return {
    kind: 'connection',
    operationId: operationId(),
    callerId: request.callingManagerId,
    resourceId: request.resource.id,
    database: credentials.database,
    username: credentials.username,
    phase: 'prepared',
    cleanupReason: null,
    provisionRunId: null,
    cleanupRunId: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function discardOperation(caller: RPCCaller, operation: OperationRecord): Promise<void> {
  try {
    await deleteOperation(caller, operation.operationId);
  } catch {
    // The original validation error is more useful and lock recovery handles stale state.
  }
}

function isAbort(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

async function cleanUpRacedProvision(
  deps: ConnectionWorkflowDeps,
  request: ConnectionRequest,
  platform: PlatformConnection,
  credentials: LogicalCredentials,
  operation: ConnectionOperation,
): Promise<void> {
  await transitionOperation(deps.caller, operation.operationId, 'cleanup-required', 'cleanup-starting');
  let started: unknown;
  try {
    started = await deps.caller.start(
      'cleanup-connection',
      RUNNER_IMAGE,
      buildCleanupPlan(request.primary.credentials, credentials.database, credentials.username, platform),
      `postgres-cleanup:${operation.operationId}`,
    );
  } catch {
    const match = await findCorrelatedRun(
      deps.caller, 'cleanup-connection', `postgres-cleanup:${operation.operationId}`,
    ).catch(() => ({ kind: 'ambiguous' as const }));
    if (match.kind === 'absent') {
      await transitionOperation(deps.caller, operation.operationId, 'cleanup-starting', 'cleanup-required')
        .catch(() => undefined);
    }
    if (match.kind !== 'found') throw new Error(CLEANUP_ERROR);
    started = { id: match.id };
  }
  if (!isRecord(started) || !isNonBlank(started.id)) {
    const match = await findCorrelatedRun(
      deps.caller, 'cleanup-connection', `postgres-cleanup:${operation.operationId}`,
    ).catch(() => ({ kind: 'ambiguous' as const }));
    if (match.kind === 'absent') {
      await transitionOperation(deps.caller, operation.operationId, 'cleanup-starting', 'cleanup-required')
        .catch(() => undefined);
    }
    if (match.kind !== 'found') throw new Error(CLEANUP_ERROR);
    started = { id: match.id };
  }
  const cleanupRunId = isRecord(started) && isNonBlank(started.id) ? started.id : null;
  if (!cleanupRunId) throw new Error(CLEANUP_ERROR);
  try {
    await transitionOperation(deps.caller, operation.operationId, 'cleanup-starting', {
      phase: 'cleanup-running', cleanupRunId,
    });
  } catch {
    throw new Error(CLEANUP_ERROR);
  }
  try {
    await deps.waitForRun(deps.caller, deps.events, cleanupRunId, { signal: deps.signal });
  } catch (error) {
    if (isAbort(error)) throw error;
    if (isRecord(error) && error.status === 3) {
      await transitionOperation(deps.caller, operation.operationId, 'cleanup-running', {
        phase: 'cleanup-required', cleanupRunId: null,
      }).catch(() => undefined);
    }
    // A transient monitoring failure does not prove the runner failed. Keep
    // cleanup-running and the exact run id so recovery can resume monitoring
    // without overlapping cleanup runs.
    throw new Error(CLEANUP_ERROR);
  }
  try {
    await deleteOperation(deps.caller, operation.operationId);
  } catch {
    // The existing connection is authoritative; recovery can remove stale state later.
  }
}

function isPermissionDecision(value: unknown): value is PermissionDecision {
  return isRecord(value) && typeof value.allowed === 'boolean' && typeof value.remember === 'boolean';
}

export async function createPostgresConnection(
  deps: ConnectionWorkflowDeps,
  request: ConnectionRequest,
): Promise<RPC.CreateConnection> {
  throwIfAborted(deps.signal);
  const platform = assertRequest(request);
  throwIfAborted(deps.signal);

  const existing = await findExistingConnection(
    deps.caller, request.callingManagerId, request.resource.id, platform,
  );
  if (existing) return existing;
  throwIfAborted(deps.signal);

  let allowed = isPermissionRemembered(deps.storage, request.currentManagerId, request.resource.id);
  if (!allowed) {
    const decision: unknown = await deps.requestPermission();
    if (!isPermissionDecision(decision)) throw new Error('Invalid permission decision');
    allowed = decision.allowed;
    if (!allowed) throw new Error('Database access was cancelled');
    if (decision.remember) rememberPermission(deps.storage, request.currentManagerId, request.resource.id);
  }
  throwIfAborted(deps.signal);

  const credentials = deps.generateCredentials();
  // Validate all secret-bearing inputs before creating the durable journal record.
  buildProvisionPlan(request.primary.credentials, credentials, platform);
  const operation = makeOperation(request, credentials);
  // Generated credentials are local values and are deliberately not attached to errors.
  await acquireOperation(deps.caller, operation);
  if (deps.signal.aborted) {
    await discardOperation(deps.caller, operation);
    throw abortError();
  }

  // Revalidate the caller-provided ready identity after taking the manager-wide lock.
  let revalidatedInstallation: RevalidatedInstallation;
  let plan: ReturnType<typeof buildProvisionPlan>;
  try {
    revalidatedInstallation = await revalidateInstallation(deps.caller, request);
    plan = buildProvisionPlan(revalidatedInstallation.primary.credentials, credentials, revalidatedInstallation.platform);
  } catch (error) {
    await discardOperation(deps.caller, operation);
    throw error;
  }
  await transitionOperation(deps.caller, operation.operationId, 'prepared', 'provision-starting');
  // Once this phase is recorded, an abort retains the journal for recovery because start is ambiguous.
  if (deps.signal.aborted) throw abortError();
  let started: unknown;
  try {
    started = await deps.caller.start(
      'create-connection',
      RUNNER_IMAGE,
      plan,
      `postgres-provision:${operation.operationId}`,
    );
  } catch {
    const match = await findCorrelatedRun(
      deps.caller, 'create-connection', `postgres-provision:${operation.operationId}`,
    ).catch(() => ({ kind: 'ambiguous' as const }));
    if (match.kind === 'absent') await discardOperation(deps.caller, operation);
    if (match.kind !== 'found') throw new Error(START_ERROR);
    started = { id: match.id };
  }
  if (!isRecord(started) || !isNonBlank(started.id)) {
    const match = await findCorrelatedRun(
      deps.caller, 'create-connection', `postgres-provision:${operation.operationId}`,
    ).catch(() => ({ kind: 'ambiguous' as const }));
    if (match.kind === 'absent') await discardOperation(deps.caller, operation);
    if (match.kind !== 'found') throw new Error(START_ERROR);
    started = { id: match.id };
  }
  const provisionRunId = isRecord(started) && isNonBlank(started.id) ? started.id : null;
  if (!provisionRunId) throw new Error(START_ERROR);
  let runRecorded = true;
  try {
    await transitionOperation(deps.caller, operation.operationId, 'provision-starting', {
      phase: 'provision-running', provisionRunId,
    });
  } catch {
    runRecorded = false;
    // The runner may have been accepted even when saving its id failed. An
    // exact correlation is the only safe way to recover this window.
    const match = await findCorrelatedRun(
      deps.caller, 'create-connection', `postgres-provision:${operation.operationId}`,
    ).catch(() => ({ kind: 'ambiguous' as const }));
    if (match.kind !== 'found' || match.id !== provisionRunId) throw new Error(START_ERROR);
  }
  if (!runRecorded) {
    try {
      await transitionOperation(deps.caller, operation.operationId, 'provision-starting', {
        phase: 'provision-running', provisionRunId,
      });
    } catch {
      throw new Error(START_ERROR);
    }
  }
  try {
    await deps.waitForRun(deps.caller, deps.events, provisionRunId, { signal: deps.signal });
  } catch (error) {
    if (isAbort(error)) throw error;
    if (isRecord(error) && error.status === 3) {
      try {
        await transitionOperation(deps.caller, operation.operationId, 'provision-running', {
          phase: 'cleanup-required', cleanupReason: 'provision-failed',
        });
        await cleanUpRacedProvision(deps, {
          ...request,
          resource: revalidatedInstallation.resource,
          platform: revalidatedInstallation.platform,
          primary: revalidatedInstallation.primary,
        }, revalidatedInstallation.platform, credentials, {
          ...operation, phase: 'cleanup-required', cleanupReason: 'provision-failed',
        });
      } catch (cleanupError) {
        if (isAbort(cleanupError)) throw cleanupError;
        throw new Error(CLEANUP_ERROR);
      }
    }
    throw new Error(RUN_ERROR);
  }
  await transitionOperation(deps.caller, operation.operationId, 'provision-running', 'provisioned');

  await transitionOperation(deps.caller, operation.operationId, 'provisioned', 'persisting');
  await transitionOperation(deps.caller, operation.operationId, 'persisting', 'reconciliation-required');
  const raced = await findExistingConnection(
    deps.caller, request.callingManagerId, request.resource.id, revalidatedInstallation.platform,
  );
  if (raced) {
    await transitionOperation(deps.caller, operation.operationId, 'reconciliation-required', {
      phase: 'cleanup-required', cleanupReason: 'duplicate-race',
    });
    await cleanUpRacedProvision(deps, {
      ...request,
      resource: revalidatedInstallation.resource,
      platform: revalidatedInstallation.platform,
      primary: revalidatedInstallation.primary,
    }, revalidatedInstallation.platform, credentials, operation);
    return raced;
  }
  let created: RPC.CreateConnection;
  try {
    created = await deps.caller.createConnection(
      buildConnectionMetadata(credentials, revalidatedInstallation.platform),
      request.callingManagerId,
      false,
      request.resource.id,
    );
  } catch {
    // A rejected create can still have committed. Reconcile exactly once before
    // compensating; a failed lookup is never interpreted as absence.
    let reconciled: RPC.CreateConnection | null;
    try {
      reconciled = await findExistingConnection(
        deps.caller, request.callingManagerId, request.resource.id, revalidatedInstallation.platform,
      );
    } catch (error) {
      if (error instanceof PostgresRecoveryRequiredError) throw error;
      throw new Error(PERSIST_ERROR);
    }
    if (reconciled && connectionBelongsToOperation(reconciled, operation)) {
      // The persistence call may have committed before reporting an error. A
      // matching connection is authoritative and the provisioned database is
      // the one we need to retain; only release the stale journal.
      await discardOperation(deps.caller, operation);
      return reconciled;
    }
    await transitionOperation(deps.caller, operation.operationId, 'reconciliation-required', {
      phase: 'cleanup-required', cleanupReason: 'persistence-failed',
    });
    await cleanUpRacedProvision(deps, {
      ...request,
      resource: revalidatedInstallation.resource,
      platform: revalidatedInstallation.platform,
      primary: revalidatedInstallation.primary,
    }, revalidatedInstallation.platform, credentials, {
      ...operation, phase: 'cleanup-required', cleanupReason: 'persistence-failed',
    });
    throw new Error(PERSIST_ERROR);
  }
  created = normalizePostgresConnection(created, {
    managerId: request.callingManagerId,
    resourceId: request.resource.id,
  }, revalidatedInstallation.platform);
  try {
    await deleteOperation(deps.caller, operation.operationId);
  } catch {
    // The connection is authoritative; a later duplicate check can clear stale journal state.
  }
  return created;
}
