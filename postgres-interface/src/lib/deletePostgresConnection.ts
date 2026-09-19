import type { RPCCaller, RPC, StartRunOptions } from '@ezenki/deploy-commander-installer-interface';
import { buildCleanupPlan } from './postgresPlans';
import { makeCleanupNote } from './connectionRuns';
import { listPostgresResources, readPostgresInstallation, type PostgresInstallation } from './postgresResource';
import { findCorrelatedRun } from './postgresRuns';
import { listOwnedPostgresConnections, readOwnedPostgresConnection, samePostgresConnectionTarget, type PostgresConnectionTarget } from './postgresConnectionContract';
import type { AccessRequest } from './postgresConnectionRequest';
import type { ParsedDeleteConnectionRequest } from './postgresDeleteRequest';
import { PostgresRecoveryRequiredError, PostgresRequestError } from './postgresErrors';
import { waitForRun, type RunEventSource } from './runMonitor';

const IMAGE = 'ezenki/deploy-commander-runner:latest';
const nonBlank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface DeleteConnectionChoice { id: string; access: AccessRequest }
export interface DeleteConnectionApprovalContext { callingManagerId: string; requestedConnectionId: string | null; choices: DeleteConnectionChoice[] }
export type DeleteConnectionDecision = { allowed: false } | { allowed: true; connectionId: string };
export interface DeleteConnectionRequest { currentManagerId: string; callingManagerId: string; metadata: ParsedDeleteConnectionRequest }
export interface DeleteConnectionWorkflowDeps {
  caller: RPCCaller;
  events: RunEventSource;
  requestApproval: (context: DeleteConnectionApprovalContext) => Promise<DeleteConnectionDecision>;
  waitForRun: typeof waitForRun;
  generateOperationId?: () => string;
  signal: AbortSignal;
}
export interface DeleteConnectionResult { connection: string }

function abortError(): Error { const error = new Error('Connection request aborted'); error.name = 'AbortError'; return error; }
function aborted(signal: AbortSignal): void { if (signal.aborted) throw abortError(); }
function operationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  throw new PostgresRecoveryRequiredError();
}
async function resources(caller: RPCCaller): Promise<PostgresInstallation> {
  const found = await listPostgresResources(caller);
  if (found.length !== 1) throw new PostgresRecoveryRequiredError();
  return readPostgresInstallation(caller, found[0]);
}
function choiceOf(target: PostgresConnectionTarget): DeleteConnectionChoice { return { id: target.id, access: structuredClone(target.access) }; }
function rpcStatus(value: unknown): number | null { return record(value) && typeof value.status === 'number' ? value.status : null; }

async function startCleanup(deps: DeleteConnectionWorkflowDeps, metadata: unknown, note: string): Promise<string> {
  let started: unknown;
  try {
    const options: StartRunOptions = { action: 'cleanup-connection', runner: IMAGE, metadata, note };
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

async function waitAndValidateCleanup(deps: DeleteConnectionWorkflowDeps, runId: string): Promise<void> {
  let completed: RPC.GetRun;
  try { completed = await deps.waitForRun(deps.caller, deps.events, runId, { signal: deps.signal }); }
  catch (error) { if (record(error) && error.name === 'AbortError') throw error; throw new Error('PostgreSQL connection cleanup failed'); }
  if (!record(completed) || !record(completed.run) || completed.run.id !== runId || completed.run.status !== 2) throw new Error('PostgreSQL connection cleanup failed');
}

async function reconcileOrRunCleanup(deps: DeleteConnectionWorkflowDeps, installation: PostgresInstallation, target: PostgresConnectionTarget): Promise<void> {
  const identity = { operationId: (deps.generateOperationId ?? operationId)(), callerId: target.managerId, resourceId: target.resourceId };
  const metadata = buildCleanupPlan({ administrator: installation.credentials, login: { username: target.username, password: target.password }, access: target.access, resourceId: target.resourceId, platform: target.platform });
  const runId = await startCleanup(deps, metadata, makeCleanupNote(identity));
  await waitAndValidateCleanup(deps, runId);
}

export async function deletePostgresConnection(deps: DeleteConnectionWorkflowDeps, request: DeleteConnectionRequest): Promise<DeleteConnectionResult> {
  aborted(deps.signal);
  if (!nonBlank(request.currentManagerId) || !nonBlank(request.callingManagerId)) throw new PostgresRequestError(400, 'A calling manager is required');
  const installation = await resources(deps.caller);
  const owned = await listOwnedPostgresConnections(deps.caller, request.callingManagerId, installation.resource.id, installation.platform);
  const candidates = request.metadata.connectionId === null ? owned : owned.filter((target) => target.id === request.metadata.connectionId);
  if (candidates.length === 0) throw new PostgresRequestError(404, 'PostgreSQL connection was not found');
  const decision = await deps.requestApproval({ callingManagerId: request.callingManagerId, requestedConnectionId: request.metadata.connectionId, choices: candidates.map(choiceOf) });
  if (!decision || decision.allowed !== true) throw new PostgresRequestError(499, 'PostgreSQL connection deletion was cancelled');
  const approved = candidates.find((target) => target.id === decision.connectionId);
  if (!approved) throw new PostgresRequestError(400, 'Invalid PostgreSQL connection deletion approval');
  const beforeCleanup = await readOwnedPostgresConnection(deps.caller, approved.id, request.callingManagerId, installation.resource.id, installation.platform);
  if (!beforeCleanup || !samePostgresConnectionTarget(approved, beforeCleanup)) throw new PostgresRequestError(409, 'PostgreSQL connection changed during deletion');
  await reconcileOrRunCleanup(deps, installation, approved);
  const beforeDelete = await readOwnedPostgresConnection(deps.caller, approved.id, request.callingManagerId, installation.resource.id, installation.platform);
  if (beforeDelete && !samePostgresConnectionTarget(approved, beforeDelete)) throw new PostgresRequestError(409, 'PostgreSQL connection changed during deletion');
  if (beforeDelete) {
    try { await deps.caller.deleteConnection(approved.id); }
    catch (error) { if (rpcStatus(error) !== 404) throw new Error('Unable to delete the PostgreSQL connection'); }
  }
  return { connection: approved.id };
}
