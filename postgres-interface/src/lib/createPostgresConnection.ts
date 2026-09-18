import type { RPCCaller, RPC, StartRunOptions } from '@ezenki/deploy-commander-installer-interface';
import { buildCleanupPlan, buildConnectionRunPlan } from './postgresPlans';
import {
  generateAdminCredentials,
  generateLoginCredentials,
  type AdminCredentials,
  type LoginCredentials,
} from './credentials';
import {
  findExistingConnection,
  findLegacyPublishedConnection,
  findPublishedConnection,
  type ConnectionLookupResult,
} from './postgresConnectionContract';
import {
  listPostgresResources,
  readPostgresInstallation,
  type PostgresInstallation,
} from './postgresResource';
import { findCorrelatedRun, readExactRun, readLatestRun, type RunStatus } from './postgresRuns';
import {
  makeCleanupNote,
  makeProvisionNote,
  parseCleanupRun,
  parseProvisionRun,
  type CleanupRunRecord,
  type ConnectionOperationIdentity,
  type ProvisionRunRecord,
} from './connectionRuns';
import { RunFailedError, waitForRun, type RunEventSource } from './runMonitor';
import {
  OperationBusyError,
  PostgresRecoveryRequiredError,
  PostgresRequestError,
} from './postgresErrors';
import { buildInstallPlan } from './installPlan';
import { confirmCatalogCleanup, listCatalogDatabases } from './postgresCatalog';
import {
  connectionLabels,
  type AccessRequest,
  type ParsedConnectionRequest,
} from './postgresConnectionRequest';

export interface ApprovalContext {
  callingManagerId: string;
  installsPostgres: boolean;
  requestedAccess: AccessRequest | null;
  callerLabels: Record<string, string>;
  catalogDatabases: string[];
}

export type ApprovalDecision = { allowed: false } | { allowed: true; access: AccessRequest };

export interface ConnectionRequest {
  currentManagerId: string;
  callingManagerId: string;
  metadata: ParsedConnectionRequest;
}

export interface ConnectionWorkflowDeps {
  caller: RPCCaller;
  events: RunEventSource;
  requestApproval: (context: ApprovalContext) => Promise<ApprovalDecision>;
  generateAdminCredentials?: () => AdminCredentials;
  generateCredentials?: () => LoginCredentials;
  waitForRun: typeof waitForRun;
  signal: AbortSignal;
}

const IMAGE = 'ezenki/deploy-commander-runner:latest';
const START_ERROR = 'Unable to start PostgreSQL provisioning';
const RUN_ERROR = 'PostgreSQL provisioning failed';
const PERSIST_ERROR = 'Unable to save the PostgreSQL connection';
const CLEANUP_ERROR = 'Unable to clean up PostgreSQL provisioning';
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const recovery = () => new PostgresRecoveryRequiredError();

function abortError(): Error {
  const error = new Error('Connection request aborted');
  error.name = 'AbortError';
  return error;
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function isAbort(value: unknown): boolean {
  return record(value) && value.name === 'AbortError';
}

function isDatabaseRequestError(value: unknown): value is PostgresRequestError {
  return value instanceof PostgresRequestError && (value.status === 404 || value.status === 409);
}

type DatabaseFailureStatus = 404 | 409;

/**
 * Runner-role failures expose only the terminal run status through waitForRun.
 * Access plans therefore emit a non-secret marker for the two user-correctable
 * database conditions, which can be read from the durable run log and normalized
 * at the child-interface boundary.
 */
async function databaseFailureStatus(
  caller: RPCCaller,
  runId: string,
  access: AccessRequest,
  error: unknown,
): Promise<DatabaseFailureStatus | null> {
  if (!(error instanceof RunFailedError) || access.scope !== 'database') return null;
  const getRunLogs = (
    caller as unknown as {
      getRunLogs?: (options: Record<string, unknown>) => Promise<unknown>;
    }
  ).getRunLogs;
  if (typeof getRunLogs !== 'function') return null;
  try {
    const response = await getRunLogs({ run_id: runId, limit: 200, offset: 0, order: 'asc' });
    if (
      typeof response !== 'object' ||
      response === null ||
      !Array.isArray((response as { items?: unknown }).items)
    ) {
      return null;
    }
    const messages = (response as { items: unknown[] }).items
      .filter(
        (item): item is { message: string } =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { message?: unknown }).message === 'string',
      )
      .map((item) => item.message);
    if (
      messages.some((message) => message.includes('POSTGRES_MANAGER_ERROR: database-not-found'))
    ) {
      return 404;
    }
    if (
      messages.some((message) => message.includes('POSTGRES_MANAGER_ERROR: database-collision'))
    ) {
      return 409;
    }
  } catch {
    // A log lookup failure must not hide the original normalized run failure.
  }
  return null;
}

function operationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
  }
  throw recovery();
}

function status(value: unknown): RunStatus | null {
  return value === 0 || value === 1 || value === 2 || value === 3 ? value : null;
}

async function resources(caller: RPCCaller): Promise<PostgresInstallation | null> {
  const found = await listPostgresResources(caller);
  if (found.length === 0) return null;
  if (found.length !== 1) throw recovery();
  return readPostgresInstallation(caller, found[0]);
}

function accessEqual(left: AccessRequest, right: AccessRequest): boolean {
  if (left.scope !== right.scope) return false;
  if (left.scope === 'database' && right.scope === 'database') {
    return left.operation === right.operation && left.database === right.database;
  }
  return left.scope === 'full' && right.scope === 'full' && left.superuser === right.superuser;
}

function validAccess(value: unknown): value is AccessRequest {
  if (!record(value) || typeof value.scope !== 'string') return false;
  if (value.scope === 'database') {
    return (
      Object.keys(value).length === 3 &&
      (value.operation === 'create' || value.operation === 'existing') &&
      typeof value.database === 'string' &&
      value.database.length > 0 &&
      !value.database.includes('\0') &&
      value.database.toLowerCase() !== 'template0' &&
      value.database.toLowerCase() !== 'template1' &&
      new TextEncoder().encode(value.database).length <= 63
    );
  }
  return (
    value.scope === 'full' &&
    Object.keys(value).length === 2 &&
    typeof value.superuser === 'boolean'
  );
}

function startedId(value: unknown): string | null {
  return record(value) && nonBlank(value.id) ? value.id : null;
}

async function start(
  deps: ConnectionWorkflowDeps,
  action: 'create-connection' | 'cleanup-connection',
  metadata: unknown,
  note: string,
): Promise<string> {
  let id: string | null = null;
  try {
    const options: StartRunOptions = { action, runner: IMAGE, metadata, note };
    id = startedId(await deps.caller.start(options));
  } catch {
    // A lost response is reconciled by the immutable note below.
  }
  if (id) return id;
  const match = await findCorrelatedRun(deps.caller, action, note);
  if (match.kind !== 'found') {
    if (match.kind === 'ambiguous') throw recovery();
    throw new Error(action === 'create-connection' ? START_ERROR : CLEANUP_ERROR);
  }
  return match.id;
}

async function install(deps: ConnectionWorkflowDeps): Promise<PostgresInstallation> {
  aborted(deps.signal);
  const administrator = (deps.generateAdminCredentials ?? generateAdminCredentials)();
  const note = `postgres-install:${operationId()}`;
  let runId: string | null = null;
  try {
    runId = startedId(
      await deps.caller.start('create', IMAGE, buildInstallPlan(administrator), note),
    );
  } catch {
    // Correlate below.
  }
  if (!runId) {
    const match = await findCorrelatedRun(deps.caller, 'create', note);
    if (match.kind !== 'found') {
      throw match.kind === 'ambiguous' ? recovery() : new Error(START_ERROR);
    }
    runId = match.id;
  }
  let completed: RPC.GetRun;
  try {
    completed = await wait(deps, runId);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new Error('PostgreSQL installation failed');
  }
  if (
    !record(completed) ||
    !record(completed.run) ||
    completed.run.id !== runId ||
    completed.run.status !== 2
  ) {
    throw new Error('PostgreSQL installation failed');
  }
  const refreshed = await resources(deps.caller);
  if (!refreshed) throw recovery();
  return refreshed;
}

async function wait(deps: ConnectionWorkflowDeps, runId: string): Promise<RPC.GetRun> {
  return deps.waitForRun(deps.caller, deps.events, runId, { signal: deps.signal });
}

async function lookup(
  deps: ConnectionWorkflowDeps,
  installation: PostgresInstallation,
  callerId: string,
  access: AccessRequest,
  callerLabels: Record<string, string>,
): Promise<ConnectionLookupResult> {
  return findExistingConnection(
    deps.caller,
    {
      managerId: callerId,
      resourceId: installation.resource.id,
      access,
      labels: connectionLabels(access, callerLabels),
    },
    installation.platform,
  );
}

async function lookupPublished(
  deps: ConnectionWorkflowDeps,
  installation: PostgresInstallation,
  provision: ProvisionRunRecord,
): Promise<ConnectionLookupResult> {
  if (provision.version === 'v1') {
    if (provision.access.scope !== 'database') throw recovery();
    return findLegacyPublishedConnection(
      deps.caller,
      {
        managerId: provision.identity.callerId,
        resourceId: installation.resource.id,
        database: provision.access.database,
        username: provision.login.username,
        password: provision.login.password || undefined,
      },
      installation.platform,
    );
  }
  return findPublishedConnection(
    deps.caller,
    {
      managerId: provision.identity.callerId,
      resourceId: installation.resource.id,
      access: provision.access,
      username: provision.login.username,
      password: provision.login.password,
      labels: provision.labels,
    },
    installation.platform,
  );
}

async function cleanupRetry(
  deps: ConnectionWorkflowDeps,
  installation: PostgresInstallation,
  identity: ConnectionOperationIdentity,
  access: AccessRequest,
  login: LoginCredentials,
  options: { legacy?: boolean; catalogOperationId?: string } = {},
): Promise<void> {
  const fresh = { ...identity, operationId: operationId() };
  const runId = await start(
    deps,
    'cleanup-connection',
    options.legacy
      ? buildCleanupPlan(
          installation.credentials,
          access.scope === 'database' ? access.database : 'postgres',
          login.username,
          installation.platform,
        )
      : buildCleanupPlan({
          administrator: installation.credentials,
          login,
          access,
          resourceId: installation.resource.id,
          platform: installation.platform,
          catalogOperationId: options.catalogOperationId ?? identity.operationId,
        }),
    makeCleanupNote(fresh),
  );
  try {
    await wait(deps, runId);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new Error(CLEANUP_ERROR);
  }
  if (!options.legacy && access.scope === 'database' && access.operation === 'create') {
    await confirmCatalogCleanup(
      deps.caller,
      installation.resource.id,
      access.database,
      options.catalogOperationId ?? identity.operationId,
    );
  }
}

async function reconcileProvision(
  deps: ConnectionWorkflowDeps,
  provision: ProvisionRunRecord,
  requestedCallerId?: string,
  expectedAccess?: AccessRequest,
  expectedLabels?: Record<string, string>,
  runStatus?: RunStatus,
): Promise<ConnectionRecoveryResult> {
  const installation = await resources(deps.caller);
  if (!installation || installation.resource.id !== provision.identity.resourceId) throw recovery();
  if (requestedCallerId !== undefined && requestedCallerId !== provision.identity.callerId) {
    return { kind: 'retry' };
  }
  if (expectedAccess && !accessEqual(expectedAccess, provision.access)) return { kind: 'retry' };
  if (expectedLabels && provision.version !== 'v1') {
    const actualLabels = Object.fromEntries(
      Object.entries(provision.labels).filter(
        ([key]) => key !== 'postgres.access' && key !== 'postgres.database',
      ),
    );
    const expectedKeys = Object.keys(expectedLabels);
    if (
      expectedKeys.length !== Object.keys(actualLabels).length ||
      expectedKeys.some((key) => actualLabels[key] !== expectedLabels[key])
    ) {
      return { kind: 'retry' };
    }
  }
  // The v1 connection contract has no labels or access discriminator.  Use
  // the persisted database/login to preserve a published legacy connection.
  const published = await lookupPublished(deps, installation, provision);
  if (published.kind === 'match') return { kind: 'connection', value: published.connection };
  if (published.kind === 'conflict') throw recovery();
  if (runStatus === 2) throw recovery();
  if (runStatus === 3) {
    await cleanupRetry(deps, installation, provision.identity, provision.access, provision.login, {
      legacy: provision.version === 'v1',
      catalogOperationId: provision.identity.operationId,
    });
  }
  return { kind: 'retry' };
}

async function reconcileFailedWait(
  deps: ConnectionWorkflowDeps,
  runId: string,
  installation: PostgresInstallation,
  identity: ConnectionOperationIdentity,
  access: AccessRequest,
  login: LoginCredentials,
  labels: Record<string, string>,
  originalError: unknown,
): Promise<RPC.CreateConnection | null> {
  let exact: RPC.GetRun;
  try {
    exact = await readExactRun(deps.caller, runId);
  } catch {
    // Older host test doubles predate getRun on the caller.  The production
    // interface always exposes it; retain the v1 failure fallback only for
    // that explicitly absent method, never for an uncertain transport read.
    if (originalError instanceof RunFailedError && typeof deps.caller.getRun !== 'function') {
      const failureStatus = await databaseFailureStatus(deps.caller, runId, access, originalError);
      await cleanupRetry(deps, installation, identity, access, login);
      if (failureStatus !== null) {
        throw new PostgresRequestError(
          failureStatus,
          failureStatus === 404
            ? 'Requested PostgreSQL database was not found'
            : 'Requested PostgreSQL database already exists',
        );
      }
      throw new Error(RUN_ERROR);
    }
    // The terminal state is unknown.  Never compensate an operation that may
    // still be active or may already have published a connection.
    throw recovery();
  }
  const terminalStatus = status(exact.run.status);
  if (terminalStatus === null || terminalStatus < 2) throw recovery();
  const provision = parseProvisionRun(exact);
  if (
    provision.identity.operationId !== identity.operationId ||
    !accessEqual(provision.access, access) ||
    provision.login.username !== login.username ||
    provision.login.password !== login.password
  )
    throw recovery();
  const reconciled = await reconcileProvision(
    deps,
    provision,
    identity.callerId,
    access,
    Object.fromEntries(
      Object.entries(labels).filter(
        ([key]) => key !== 'postgres.access' && key !== 'postgres.database',
      ),
    ),
    terminalStatus,
  );
  if (reconciled.kind === 'connection') return reconciled.value;
  if (terminalStatus !== 3) throw recovery();
  const failureStatus = await databaseFailureStatus(deps.caller, runId, access, originalError);
  if (failureStatus !== null) {
    throw new PostgresRequestError(
      failureStatus,
      failureStatus === 404
        ? 'Requested PostgreSQL database was not found'
        : 'Requested PostgreSQL database already exists',
    );
  }
  throw new Error(RUN_ERROR);
}

export type ConnectionRecoveryResult =
  { kind: 'retry' } | { kind: 'connection'; value: RPC.CreateConnection };

export async function reconcileLatestConnectionRun(
  deps: ConnectionWorkflowDeps,
  latest: RPC.RunItem | null,
  requestedCallerId?: string,
  expectedAccess?: AccessRequest,
  expectedLabels?: Record<string, string>,
): Promise<ConnectionRecoveryResult | null> {
  if (
    !latest ||
    (latest.action !== 'create-connection' && latest.action !== 'cleanup-connection')
  ) {
    return null;
  }
  let exact: RPC.GetRun;
  try {
    exact =
      latest.status < 2 ? await wait(deps, latest.id) : await readExactRun(deps.caller, latest.id);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw recovery();
  }
  const runStatus = status(exact.run.status);
  if (runStatus === null) throw recovery();
  if (exact.run.action === 'cleanup-connection') {
    const cleanup: CleanupRunRecord = parseCleanupRun(exact);
    if (runStatus < 2) throw recovery();
    if (runStatus === 2) return { kind: 'retry' };
    const installation = await resources(deps.caller);
    if (!installation) throw recovery();
    await cleanupRetry(deps, installation, cleanup.identity, cleanup.access, cleanup.login, {
      legacy: cleanup.version === 'v1',
      catalogOperationId: cleanup.catalogOperationId ?? cleanup.identity.operationId,
    });
    return { kind: 'retry' };
  }
  const provision = parseProvisionRun(exact);
  if (runStatus < 2) throw recovery();
  return reconcileProvision(
    deps,
    provision,
    requestedCallerId,
    expectedAccess,
    expectedLabels,
    runStatus,
  );
}

export async function createPostgresConnection(
  deps: ConnectionWorkflowDeps,
  request: ConnectionRequest,
): Promise<RPC.CreateConnection> {
  aborted(deps.signal);
  if (!nonBlank(request.currentManagerId) || !nonBlank(request.callingManagerId)) {
    throw new Error('A calling manager is required');
  }
  if (!record(request.metadata)) {
    throw new PostgresRequestError(400, 'Invalid PostgreSQL connection request');
  }
  const requestedAccess = request.metadata.access;
  const callerLabels = request.metadata.labels;
  let installation = await resources(deps.caller);
  let latest: RPC.RunItem | null = null;
  if (!installation) {
    latest = await readLatestRun(deps.caller);
    if (latest && (latest.action === 'create' || latest.action === 'teardown') && latest.status < 2)
      throw new OperationBusyError();
    if (latest && (latest.action !== 'teardown' || latest.status !== 2)) throw recovery();
  }

  let catalogDatabases: string[] = [];
  if (installation)
    catalogDatabases = await listCatalogDatabases(deps.caller, installation.resource.id);
  const decision = await deps.requestApproval({
    callingManagerId: request.callingManagerId,
    installsPostgres: installation === null,
    requestedAccess,
    callerLabels,
    catalogDatabases,
  });
  if (!decision || decision.allowed !== true) {
    throw new PostgresRequestError(499, 'Database access was cancelled');
  }
  if (!validAccess(decision.access)) {
    throw new PostgresRequestError(400, 'Invalid approved access request');
  }
  if (requestedAccess && !accessEqual(requestedAccess, decision.access)) {
    throw new PostgresRequestError(400, 'Approved access does not match the manager request');
  }
  const access = decision.access;

  if (installation) {
    latest = await readLatestRun(deps.caller);
    if (latest?.action === 'create' || latest?.action === 'teardown') {
      if (latest.status < 2) throw new OperationBusyError();
      // A terminal lifecycle failure or a completed teardown alongside a
      // visible resource is contradictory.  Do not provision into it.
      if (latest.status === 3 || latest.action === 'teardown') throw recovery();
    }
    const recovered = await reconcileLatestConnectionRun(
      deps,
      latest,
      request.callingManagerId,
      access,
      callerLabels,
    );
    if (recovered?.kind === 'connection') return recovered.value;
  }

  if (!installation) installation = await install(deps);
  installation =
    (await resources(deps.caller)) ??
    (() => {
      throw recovery();
    })();

  const current = await lookup(deps, installation, request.callingManagerId, access, callerLabels);
  if (current.kind === 'match') return current.connection;
  if (current.kind === 'conflict') {
    throw new PostgresRequestError(
      409,
      'A PostgreSQL connection already exists with different labels',
    );
  }

  aborted(deps.signal);
  const login = (deps.generateCredentials ?? generateLoginCredentials)();
  const identity: ConnectionOperationIdentity = {
    operationId: operationId(),
    callerId: request.callingManagerId,
    resourceId: installation.resource.id,
  };
  const runId = await start(
    deps,
    'create-connection',
    buildConnectionRunPlan({
      administrator: installation.credentials,
      login,
      access,
      callerId: request.callingManagerId,
      resourceId: installation.resource.id,
      platform: installation.platform,
      callerLabels,
      operationId: identity.operationId,
    }),
    makeProvisionNote(identity),
  );
  try {
    await wait(deps, runId);
  } catch (error) {
    if (isAbort(error)) throw error;
    const recovered = await reconcileFailedWait(
      deps,
      runId,
      installation,
      identity,
      access,
      login,
      callerLabels,
      error,
    );
    if (recovered) return recovered;
    if (isDatabaseRequestError(error)) throw error;
    throw new Error(RUN_ERROR);
  }

  let persisted: ConnectionLookupResult;
  try {
    persisted = await lookup(deps, installation, request.callingManagerId, access, callerLabels);
  } catch (error) {
    if (isAbort(error)) throw error;
    // A successful runner may already have published the connection.  A
    // failed enumeration is not evidence that it did not; reconcile by the
    // operation's credentials and leave recovery to the next request.
    let exact: RPC.GetRun;
    try {
      exact = await readExactRun(deps.caller, runId);
      if (status(exact.run.status) !== 2) throw recovery();
      const published = await findPublishedConnection(
        deps.caller,
        {
          managerId: request.callingManagerId,
          resourceId: installation.resource.id,
          access,
          username: login.username,
          password: login.password,
          labels: connectionLabels(access, callerLabels),
        },
        installation.platform,
      );
      if (published.kind === 'match') return published.connection;
    } catch (recoveryError) {
      if (isAbort(recoveryError)) throw recoveryError;
      throw recovery();
    }
    throw new Error(PERSIST_ERROR);
  }
  if (persisted.kind === 'match') return persisted.connection;
  if (persisted.kind === 'conflict') {
    throw new PostgresRequestError(
      409,
      'A PostgreSQL connection already exists with different labels',
    );
  }
  // The runner reported success but publication is not observable yet.  Do
  // not drop the database/role; surface recovery so a later request can
  // reconcile the durable connection.
  throw new Error(PERSIST_ERROR);
}
