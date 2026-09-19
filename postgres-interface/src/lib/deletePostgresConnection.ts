import type { RPCCaller, RPC, StartRunOptions } from '@ezenki/deploy-commander-installer-interface';
import { buildCleanupPlan } from './postgresPlans';
import { makeCleanupNote, parseCleanupRun, type CleanupRunRecord } from './connectionRuns';
import {
  listPostgresResources,
  readPostgresInstallation,
  type PostgresInstallation,
} from './postgresResource';
import { findCorrelatedRun, readExactRun } from './postgresRuns';
import {
  listResourcePostgresConnections,
  readOwnedPostgresConnection,
  samePostgresConnectionTarget,
  type PostgresConnectionTarget,
} from './postgresConnectionContract';
import type { AccessRequest } from './postgresConnectionRequest';
import type { ParsedDeleteConnectionRequest } from './postgresDeleteRequest';
import { PostgresRecoveryRequiredError, PostgresRequestError } from './postgresErrors';
import { waitForRun, type RunEventSource } from './runMonitor';

const IMAGE = 'ezenki/deploy-commander-runner:latest';
const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface DeleteConnectionChoice {
  id: string;
  access: AccessRequest;
  origin?: 'managed' | 'existing' | null;
  cleanup?: 'role-only' | 'role-and-database';
}
export interface DeleteConnectionApprovalContext {
  callingManagerId: string;
  requestedConnectionId: string | null;
  choices: DeleteConnectionChoice[];
}
export type DeleteConnectionDecision = { allowed: false } | { allowed: true; connectionId: string };
export interface DeleteConnectionRequest {
  currentManagerId: string;
  callingManagerId: string;
  metadata: ParsedDeleteConnectionRequest;
}
export interface DeleteConnectionWorkflowDeps {
  caller: RPCCaller;
  events: RunEventSource;
  requestApproval: (context: DeleteConnectionApprovalContext) => Promise<DeleteConnectionDecision>;
  waitForRun: typeof waitForRun;
  generateOperationId?: () => string;
  signal: AbortSignal;
}
export interface DeleteConnectionResult {
  connection: string;
}

function abortError(): Error {
  const error = new Error('Connection request aborted');
  error.name = 'AbortError';
  return error;
}
function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}
function operationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  throw new PostgresRecoveryRequiredError();
}
async function resources(caller: RPCCaller): Promise<PostgresInstallation> {
  const found = await listPostgresResources(caller);
  if (found.length !== 1) throw new PostgresRecoveryRequiredError();
  return readPostgresInstallation(caller, found[0]);
}
function choiceOf(
  target: PostgresConnectionTarget,
  resourceConnections: PostgresConnectionTarget[],
): DeleteConnectionChoice {
  return {
    id: target.id,
    access: structuredClone(target.access),
    origin: target.origin,
    cleanup: deletionCleanup(target, resourceConnections),
  };
}

export function deletionCleanup(
  target: PostgresConnectionTarget,
  resourceConnections: PostgresConnectionTarget[],
): 'role-only' | 'role-and-database' {
  if (target.access.scope !== 'database' || target.origin !== 'managed') return 'role-only';
  const database = target.access.database;
  const peers = resourceConnections.filter(
    (candidate) =>
      candidate.id !== target.id &&
      candidate.access.scope === 'database' &&
      candidate.access.database === database,
  );
  return peers.length === 0 ? 'role-and-database' : 'role-only';
}
function rpcStatus(value: unknown): number | null {
  return record(value) && typeof value.status === 'number' ? value.status : null;
}

async function startCleanup(
  deps: DeleteConnectionWorkflowDeps,
  metadata: unknown,
  note: string,
): Promise<string> {
  let started: unknown;
  try {
    const options: StartRunOptions = {
      action: 'cleanup-connection',
      runner: IMAGE,
      metadata,
      note,
    };
    started = await deps.caller.start(options);
  } catch {
    started = null;
  }
  if (record(started) && nonBlank(started.id)) return started.id;
  const match = await findCorrelatedRun(deps.caller, 'cleanup-connection', note);
  if (match.kind === 'found') return match.id;
  if (match.kind === 'ambiguous') throw new PostgresRecoveryRequiredError();
  throw new Error('Unable to start PostgreSQL cleanup');
}

function accessEqual(left: AccessRequest, right: AccessRequest): boolean {
  if (left.scope !== right.scope) return false;
  if (left.scope === 'database' && right.scope === 'database')
    return left.operation === right.operation && left.database === right.database;
  return left.scope === 'full' && right.scope === 'full' && left.superuser === right.superuser;
}
function cleanupMatchesTarget(
  recordValue: CleanupRunRecord,
  target: PostgresConnectionTarget,
): boolean {
  return (
    recordValue.version === 'v2' &&
    recordValue.platform !== undefined &&
    recordValue.identity.callerId === target.managerId &&
    recordValue.identity.resourceId === target.resourceId &&
    recordValue.login.username === target.username &&
    recordValue.login.password === target.password &&
    accessEqual(recordValue.access, target.access) &&
    recordValue.platform.type === target.platform.type &&
    recordValue.platform.data.network === target.platform.data.network
  );
}

async function waitAndValidateCleanup(
  deps: DeleteConnectionWorkflowDeps,
  runId: string,
  target: PostgresConnectionTarget,
): Promise<void> {
  let completed: RPC.GetRun;
  try {
    completed = await deps.waitForRun(deps.caller, deps.events, runId, { signal: deps.signal });
  } catch (error) {
    if (record(error) && error.name === 'AbortError') throw error;
    completed = await readExactRun(deps.caller, runId);
  }
  const cleanup = parseCleanupRun(completed);
  if (!cleanupMatchesTarget(cleanup, target)) throw new PostgresRecoveryRequiredError();
  if (cleanup.status === 3) throw new Error('PostgreSQL connection cleanup failed');
  if (cleanup.status !== 2) throw new PostgresRecoveryRequiredError();
}

async function reconcileOrRunCleanup(
  deps: DeleteConnectionWorkflowDeps,
  installation: PostgresInstallation,
  target: PostgresConnectionTarget,
  cleanup: 'role-only' | 'role-and-database',
): Promise<void> {
  const identity = {
    operationId: (deps.generateOperationId ?? operationId)(),
    callerId: target.managerId,
    resourceId: target.resourceId,
  };
  const metadata = buildCleanupPlan({
    administrator: installation.credentials,
    login: { username: target.username, password: target.password },
    access:
      target.access.scope === 'database' && cleanup === 'role-only'
        ? { ...target.access, operation: 'existing' }
        : target.access,
    resourceId: target.resourceId,
    platform: target.platform,
  });
  const runId = await startCleanup(deps, metadata, makeCleanupNote(identity));
  await waitAndValidateCleanup(deps, runId, target);
}

export async function deletePostgresConnection(
  deps: DeleteConnectionWorkflowDeps,
  request: DeleteConnectionRequest,
): Promise<DeleteConnectionResult> {
  aborted(deps.signal);
  if (!nonBlank(request.currentManagerId) || !nonBlank(request.callingManagerId))
    throw new PostgresRequestError(400, 'A calling manager is required');
  const installation = await resources(deps.caller);
  const resourceConnections = await listResourcePostgresConnections(
    deps.caller,
    installation.resource.id,
    installation.platform,
  );
  const owned = resourceConnections.filter(
    (target) => target.managerId === request.callingManagerId,
  );
  const candidates =
    request.metadata.connectionId === null
      ? owned
      : owned.filter((target) => target.id === request.metadata.connectionId);
  if (candidates.length === 0)
    throw new PostgresRequestError(404, 'PostgreSQL connection was not found');
  const decision = await deps.requestApproval({
    callingManagerId: request.callingManagerId,
    requestedConnectionId: request.metadata.connectionId,
    choices: candidates.map((target) => choiceOf(target, resourceConnections)),
  });
  if (!decision || decision.allowed !== true)
    throw new PostgresRequestError(499, 'PostgreSQL connection deletion was cancelled');
  const approved = candidates.find((target) => target.id === decision.connectionId);
  if (!approved)
    throw new PostgresRequestError(400, 'Invalid PostgreSQL connection deletion approval');
  const freshConnections = await listResourcePostgresConnections(
    deps.caller,
    installation.resource.id,
    installation.platform,
  );
  const freshTarget = freshConnections.find((target) => target.id === approved.id);
  if (!freshTarget || !samePostgresConnectionTarget(approved, freshTarget))
    throw new PostgresRequestError(409, 'PostgreSQL connection changed during deletion');
  if (
    deletionCleanup(approved, resourceConnections) !==
    deletionCleanup(freshTarget, freshConnections)
  )
    throw new PostgresRequestError(409, 'PostgreSQL connection deletion consequences changed');
  const beforeCleanup = await readOwnedPostgresConnection(
    deps.caller,
    approved.id,
    request.callingManagerId,
    installation.resource.id,
    installation.platform,
  );
  if (!beforeCleanup || !samePostgresConnectionTarget(approved, beforeCleanup))
    throw new PostgresRequestError(409, 'PostgreSQL connection changed during deletion');
  await reconcileOrRunCleanup(
    deps,
    installation,
    approved,
    deletionCleanup(approved, resourceConnections),
  );
  const beforeDelete = await readOwnedPostgresConnection(
    deps.caller,
    approved.id,
    request.callingManagerId,
    installation.resource.id,
    installation.platform,
  );
  if (beforeDelete && !samePostgresConnectionTarget(approved, beforeDelete))
    throw new PostgresRequestError(409, 'PostgreSQL connection changed during deletion');
  if (beforeDelete) {
    try {
      await deps.caller.deleteConnection(approved.id);
    } catch (error) {
      if (rpcStatus(error) !== 404) throw new Error('Unable to delete the PostgreSQL connection');
    }
  }
  return { connection: approved.id };
}
