import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { buildCleanupPlan, buildConnectionMetadata, buildProvisionPlan } from './postgresPlans';
import { isPermissionRemembered, rememberPermission } from './permissionPreference';
import type { AdminCredentials, LogicalCredentials } from './credentials';
import { findExistingConnection, normalizePostgresConnection } from './postgresConnectionContract';
import { listPostgresResources, readPostgresInstallation, type PostgresInstallation } from './postgresResource';
import { findCorrelatedRun, readExactRun, readLatestRun, type RunStatus } from './postgresRuns';
import { makeCleanupNote, makeProvisionNote, parseCleanupRun, parseProvisionRun } from './connectionRuns';
import { waitForRun, type RunEventSource } from './runMonitor';
import { PostgresRecoveryRequiredError } from './postgresErrors';
import { buildInstallPlan } from './installPlan';

export interface ConnectionRequest {
  currentManagerId: string;
  callingManagerId: string;
  /** Compatibility fields from pre-run-backed consumers are ignored. */
  [key: string]: unknown;
}
export interface PermissionContext { installsPostgres: boolean; }
export interface PermissionDecision { allowed: boolean; remember: boolean; }
export interface ConnectionWorkflowDeps {
  caller: RPCCaller; events: RunEventSource; storage: Storage;
  requestPermission: (context: PermissionContext) => Promise<PermissionDecision>;
  generateAdminCredentials?: () => AdminCredentials;
  generateCredentials: () => LogicalCredentials; waitForRun: typeof waitForRun; signal: AbortSignal;
}
const IMAGE = 'ezenki/deploy-commander-runner:latest';
const START_ERROR = 'Unable to start PostgreSQL provisioning';
const RUN_ERROR = 'PostgreSQL provisioning failed';
const PERSIST_ERROR = 'Unable to save the PostgreSQL connection';
const CLEANUP_ERROR = 'Unable to clean up PostgreSQL provisioning';
type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const recovery = () => new PostgresRecoveryRequiredError();
function abortError(): Error { const e = new Error('Connection request aborted'); e.name = 'AbortError'; return e; }
function aborted(signal: AbortSignal): void { if (signal.aborted) throw abortError(); }
function isAbort(v: unknown): boolean { return record(v) && v.name === 'AbortError'; }
function operationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') return Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) => v.toString(16).padStart(2, '0')).join('');
  throw recovery();
}
function status(v: unknown): RunStatus | null { return v === 0 || v === 1 || v === 2 || v === 3 ? v : null; }
async function resources(caller: RPCCaller): Promise<PostgresInstallation | null> {
  const found = await listPostgresResources(caller);
  if (found.length === 0) return null;
  if (found.length !== 1) throw recovery();
  return readPostgresInstallation(caller, found[0]);
}
async function existing(deps: ConnectionWorkflowDeps, installation: PostgresInstallation, callerId: string) {
  return findExistingConnection(deps.caller, callerId, installation.resource.id, installation.platform);
}
function startedId(v: unknown): string | null { return record(v) && nonBlank(v.id) ? v.id : null; }
async function start(deps: ConnectionWorkflowDeps, action: 'create-connection' | 'cleanup-connection', plan: unknown, note: string): Promise<string> {
  let id: string | null = null;
  try { id = startedId(await deps.caller.start(action, IMAGE, plan, note)); } catch { /* correlate below */ }
  if (!id) { const match = await findCorrelatedRun(deps.caller, action, note); if (match.kind !== 'found') throw new Error(action === 'create-connection' ? START_ERROR : CLEANUP_ERROR); id = match.id; }
  return id;
}
async function install(deps: ConnectionWorkflowDeps): Promise<PostgresInstallation> {
  const administrator = (deps.generateAdminCredentials ?? (() => { throw recovery(); }))();
  const note = `postgres-install:${operationId()}`;
  let runId = startedId(await deps.caller.start('create', IMAGE, buildInstallPlan(administrator), note).catch(() => null));
  if (!runId) {
    const match = await findCorrelatedRun(deps.caller, 'create', note);
    if (match.kind !== 'found') throw new Error(START_ERROR);
    runId = match.id;
  }
  try { await wait(deps, runId); } catch (error) {
    if (isAbort(error)) throw error;
    throw new Error('PostgreSQL installation failed');
  }
  // The runner-created resource is authoritative. Never continue with the
  // pre-install request or credentials after the run completes.
  const refreshed = await resources(deps.caller);
  if (!refreshed) throw recovery();
  return refreshed;
}
async function wait(deps: ConnectionWorkflowDeps, runId: string): Promise<RPC.GetRun> { return deps.waitForRun(deps.caller, deps.events, runId, { signal: deps.signal }); }
function matching(connection: RPC.CreateConnection, database: string, username: string): boolean { return record(connection.config) && record(connection.config.metadata) && connection.config.metadata.database === database && connection.config.metadata.username === username; }
async function cleanupRetry(deps: ConnectionWorkflowDeps, installation: PostgresInstallation, identity: { operationId: string; callerId: string; resourceId: string }, database: string, username: string): Promise<void> {
  const fresh = { ...identity, operationId: operationId() };
  const runId = await start(deps, 'cleanup-connection', buildCleanupPlan(installation.credentials, database, username, installation.platform), makeCleanupNote(fresh));
  try { await wait(deps, runId); } catch (e) { if (isAbort(e)) throw e; throw new Error(CLEANUP_ERROR); }
}
export type ConnectionRecoveryResult = { kind: 'retry' } | { kind: 'connection'; value: RPC.CreateConnection };
export async function reconcileLatestConnectionRun(deps: ConnectionWorkflowDeps, latest: RPC.RunItem | null, requestedCallerId?: string): Promise<ConnectionRecoveryResult | null> {
  if (!latest || (latest.action !== 'create-connection' && latest.action !== 'cleanup-connection')) return null;
  let exact: RPC.GetRun;
  try { exact = latest.status < 2 ? await wait(deps, latest.id) : await readExactRun(deps.caller, latest.id); } catch (e) { if (isAbort(e)) throw e; throw recovery(); }
  const runStatus = status(exact.run.status); if (runStatus === null) throw recovery();
  if (exact.run.action === 'cleanup-connection') {
    const cleanup = parseCleanupRun(exact); if (runStatus < 2) throw recovery();
    const installation = await resources(deps.caller); if (!installation) throw recovery();
    if (runStatus === 2) return { kind: 'retry' };
    await cleanupRetry(deps, installation, cleanup.identity, cleanup.database, cleanup.username); return { kind: 'retry' };
  }
  const provision = parseProvisionRun(exact); if (runStatus < 2) throw recovery();
  const installation = await resources(deps.caller); if (!installation || installation.resource.id !== provision.identity.resourceId) throw recovery();
  const found = await existing(deps, installation, provision.identity.callerId);
  if (found) { if (requestedCallerId !== undefined && requestedCallerId !== provision.identity.callerId) return { kind: 'retry' }; return { kind: 'connection', value: found }; }
  if (runStatus === 3) { await cleanupRetry(deps, installation, provision.identity, provision.logical.database, provision.logical.username); return { kind: 'retry' }; }
  let created: RPC.CreateConnection;
  try { created = await deps.caller.createConnection(buildConnectionMetadata(provision.logical, installation.platform), provision.identity.callerId, false, installation.resource.id); }
  catch {
    let after: RPC.CreateConnection | null;
    try { after = await existing(deps, installation, provision.identity.callerId); }
    catch (e) { if (e instanceof PostgresRecoveryRequiredError) throw e; throw new Error(PERSIST_ERROR); }
    if (after && matching(after, provision.logical.database, provision.logical.username)) return { kind: 'connection', value: after };
    await cleanupRetry(deps, installation, provision.identity, provision.logical.database, provision.logical.username); throw new Error(PERSIST_ERROR);
  }
  return { kind: 'connection', value: normalizePostgresConnection(created, { managerId: provision.identity.callerId, resourceId: installation.resource.id }, installation.platform) };
}
export async function createPostgresConnection(deps: ConnectionWorkflowDeps, request: ConnectionRequest): Promise<RPC.CreateConnection> {
  aborted(deps.signal); if (!nonBlank(request.currentManagerId) || !nonBlank(request.callingManagerId)) throw new Error('A calling manager is required');
  let installation = await resources(deps.caller);
  let latest: RPC.RunItem | null = null;
  // An absent resource is installable only after a confirmed teardown (or
  // when no lifecycle run exists). Any other latest run means the durable
  // state contradicts discovery and must be recovered by the manager.
  if (!installation) {
    latest = await readLatestRun(deps.caller);
    if (latest && (latest.action !== 'teardown' || latest.status !== 2)) throw recovery();
  }
  if (installation) {
    const found = await existing(deps, installation, request.callingManagerId); if (found) return found;
    latest = await readLatestRun(deps.caller);
    const recovered = await reconcileLatestConnectionRun(deps, latest, request.callingManagerId); if (recovered?.kind === 'connection') return recovered.value;
  }
  aborted(deps.signal);
  const permissionResourceId = installation?.resource.id ?? 'not-installed';
  let allowed = isPermissionRemembered(deps.storage, request.currentManagerId, permissionResourceId);
  let remember = false;
  if (!allowed) { const decision = await deps.requestPermission({ installsPostgres: installation === null }); if (!decision || typeof decision.allowed !== 'boolean' || typeof decision.remember !== 'boolean') throw new Error('Invalid permission decision'); if (!decision.allowed) throw new Error('Database access was cancelled'); allowed = true; remember = decision.remember; if (decision.remember && installation) rememberPermission(deps.storage, request.currentManagerId, installation.resource.id); }
  if (!installation) { installation = await install(deps); if (remember) rememberPermission(deps.storage, request.currentManagerId, installation.resource.id); }
  // Always use the post-install resource configuration, including its current
  // administrator and platform connection, for all subsequent RPCs.
  installation = await resources(deps.caller) ?? (() => { throw recovery(); })();
  aborted(deps.signal); const logical = deps.generateCredentials(); const plan = buildProvisionPlan(installation.credentials, logical, installation.platform); const identity = { operationId: operationId(), callerId: request.callingManagerId, resourceId: installation.resource.id };
  const runId = await start(deps, 'create-connection', plan, makeProvisionNote(identity));
  try { await wait(deps, runId); } catch (e) { if (isAbort(e)) throw e; if (record(e) && e.status === 3) { await cleanupRetry(deps, installation, identity, logical.database, logical.username); throw new Error(RUN_ERROR); } throw new Error(RUN_ERROR); }
  const raced = await existing(deps, installation, request.callingManagerId); if (raced) { await cleanupRetry(deps, installation, identity, logical.database, logical.username); return raced; }
  let created: RPC.CreateConnection;
  try { created = await deps.caller.createConnection(buildConnectionMetadata(logical, installation.platform), request.callingManagerId, false, installation.resource.id); }
  catch {
    let reconciled: RPC.CreateConnection | null;
    try { reconciled = await existing(deps, installation, request.callingManagerId); }
    catch (e) { if (e instanceof PostgresRecoveryRequiredError) throw e; throw new Error(PERSIST_ERROR); }
    if (reconciled && matching(reconciled, logical.database, logical.username)) return reconciled;
    await cleanupRetry(deps, installation, identity, logical.database, logical.username); throw new Error(PERSIST_ERROR);
  }
  return normalizePostgresConnection(created, { managerId: request.callingManagerId, resourceId: installation.resource.id }, installation.platform);
}
