import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import { PostgresRecoveryRequiredError } from './postgresErrors';
import { CATALOG_DELETE_QUERY, CATALOG_UPSERT_QUERY, catalogRecordId } from './postgresCatalog';
import { connectionLabels, type AccessRequest } from './postgresConnectionRequest';
import { parsePlatformConnection, type PlatformConnection } from './postgresContracts';

export type RunStatus = 0 | 1 | 2 | 3;
export interface ConnectionOperationIdentity {
  operationId: string;
  callerId: string;
  resourceId: string;
}
export interface LoginCredentials {
  username: string;
  password: string;
}
export interface ProvisionRunRecord {
  identity: ConnectionOperationIdentity;
  runId: string;
  status: RunStatus;
  access: AccessRequest;
  login: LoginCredentials;
  labels: Record<string, string>;
  /** @deprecated v1 workflow compatibility. */ logical: {
    database: string;
    username: string;
    password: string;
  };
}
export interface CleanupRunRecord {
  identity: ConnectionOperationIdentity;
  runId: string;
  status: RunStatus;
  access: AccessRequest;
  login: LoginCredentials;
  labels: Record<string, string>;
  /** @deprecated v1 workflow compatibility. */ database: string;
  /** @deprecated v1 workflow compatibility. */ username: string;
}
export type ConnectionNote = ({ kind: 'provision' } | { kind: 'cleanup' }) &
  ConnectionOperationIdentity;

const OPERATION_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const DATABASE = /^(?!template0$|template1$)[^\0]{1,63}$/i;
const GENERATED_DATABASE = /^db_[0-9a-f]{32}$/;
const USERNAME = /^dc_user_[0-9a-f]{32}$/;
const ADMIN_USERNAME = /^dc_admin_[0-9a-f]{32}$/;
type UnknownRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is UnknownRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const recovery = (): PostgresRecoveryRequiredError => new PostgresRecoveryRequiredError();
const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function validDatabase(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    DATABASE.test(value) &&
    new TextEncoder().encode(value).length <= 63
  );
}
function validIdentity(identity: ConnectionOperationIdentity): void {
  if (
    !isRecord(identity) ||
    !nonBlank(identity.callerId) ||
    !nonBlank(identity.resourceId) ||
    !nonBlank(identity.operationId) ||
    !OPERATION_ID.test(identity.operationId)
  )
    throw recovery();
}
function makeNote(kind: 'provision' | 'cleanup', identity: ConnectionOperationIdentity): string {
  validIdentity(identity);
  return `postgres-${kind}:v2:${encodeURIComponent(identity.callerId)}:${encodeURIComponent(identity.resourceId)}:${identity.operationId}`;
}
export const makeProvisionNote = (identity: ConnectionOperationIdentity): string =>
  makeNote('provision', identity);
export const makeCleanupNote = (identity: ConnectionOperationIdentity): string =>
  makeNote('cleanup', identity);

export function parseConnectionNote(note: unknown): ConnectionNote {
  if (typeof note !== 'string') throw recovery();
  const fields = note.split(':');
  if (
    fields.length !== 5 ||
    (fields[0] !== 'postgres-provision' && fields[0] !== 'postgres-cleanup') ||
    (fields[1] !== 'v1' && fields[1] !== 'v2') ||
    !nonBlank(fields[2]) ||
    !nonBlank(fields[3]) ||
    !OPERATION_ID.test(fields[4])
  )
    throw recovery();
  let callerId: string;
  let resourceId: string;
  try {
    callerId = decodeURIComponent(fields[2]);
    resourceId = decodeURIComponent(fields[3]);
  } catch {
    throw recovery();
  }
  const identity = { operationId: fields[4], callerId, resourceId };
  validIdentity(identity);
  return { kind: fields[0] === 'postgres-provision' ? 'provision' : 'cleanup', ...identity };
}

function isStatus(value: unknown): value is RunStatus {
  return value === 0 || value === 1 || value === 2 || value === 3;
}
function readRun(value: unknown, expectedAction: 'create-connection' | 'cleanup-connection') {
  if (!isRecord(value) || !isRecord(value.run) || !isRecord(value.config)) throw recovery();
  const run = value.run;
  const config = value.config;
  if (
    !nonBlank(run.id) ||
    run.action !== expectedAction ||
    !nonBlank(run.note) ||
    !nonBlank(run.created_at) ||
    !nonBlank(run.queued_at) ||
    !nonBlank(run.updated_at) ||
    !isStatus(run.status) ||
    config.run !== run.id ||
    config.action !== expectedAction
  )
    throw recovery();
  const note = parseConnectionNote(run.note);
  if (note.kind !== (expectedAction === 'create-connection' ? 'provision' : 'cleanup'))
    throw recovery();
  return {
    run: run as unknown as RPC.RunItem,
    config,
    note,
    noteText: run.note,
    metadata: config.metadata,
    status: run.status as RunStatus,
  };
}
function readService(metadata: unknown): {
  environment: UnknownRecord;
  command: string;
  connections: unknown;
} {
  if (!isRecord(metadata) || !isRecord(metadata.services)) throw recovery();
  const service = metadata.services['postgres-admin'];
  if (
    !isRecord(service) ||
    service.image !== 'postgres:15' ||
    service.role !== 'runner' ||
    !isRecord(service.environment) ||
    !Array.isArray(service.command) ||
    service.command.length < 3 ||
    typeof service.command[2] !== 'string'
  )
    throw recovery();
  return {
    environment: service.environment,
    command: service.command[2],
    connections: service.connections,
  };
}
function readTarget(environment: UnknownRecord): {
  database: string;
  username: string;
  password?: string;
} {
  if (
    typeof environment.TARGET_DATABASE !== 'string' ||
    !validDatabase(environment.TARGET_DATABASE) ||
    typeof environment.TARGET_USERNAME !== 'string' ||
    !USERNAME.test(environment.TARGET_USERNAME)
  )
    throw recovery();
  if (
    environment.TARGET_PASSWORD !== undefined &&
    (typeof environment.TARGET_PASSWORD !== 'string' || !nonBlank(environment.TARGET_PASSWORD))
  )
    throw recovery();
  return {
    database: environment.TARGET_DATABASE,
    username: environment.TARGET_USERNAME,
    ...(environment.TARGET_PASSWORD !== undefined ? { password: environment.TARGET_PASSWORD } : {}),
  };
}
function validateAdminEnvironment(environment: UnknownRecord): void {
  if (
    environment.PGHOST !== 'postgres' ||
    environment.PGPORT !== '5432' ||
    environment.PGDATABASE !== 'postgres' ||
    typeof environment.PGUSER !== 'string' ||
    !ADMIN_USERNAME.test(environment.PGUSER) ||
    typeof environment.PGPASSWORD !== 'string' ||
    !nonBlank(environment.PGPASSWORD)
  )
    throw recovery();
}
function validAccess(value: unknown): value is AccessRequest {
  if (!isRecord(value) || typeof value.scope !== 'string') return false;
  if (value.scope === 'database')
    return (
      Object.keys(value).length === 3 &&
      (value.operation === 'create' || value.operation === 'existing') &&
      validDatabase(value.database)
    );
  return (
    value.scope === 'full' &&
    Object.keys(value).length === 2 &&
    typeof value.superuser === 'boolean'
  );
}
function expectedMode(access: AccessRequest): string {
  return access.scope === 'database'
    ? `${access.operation}-database`
    : `full-${access.superuser ? 'superuser' : 'constrained'}`;
}
function labelsOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw recovery();
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    if (key.trim().length === 0 || typeof label !== 'string') throw recovery();
    Object.defineProperty(labels, key, {
      configurable: true,
      enumerable: true,
      value: label,
      writable: true,
    });
  }
  return labels;
}
function sameLabels(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => right[key] === left[key]);
}
function validatePlatform(value: unknown): PlatformConnection {
  try {
    return parsePlatformConnection(value);
  } catch {
    throw recovery();
  }
}
function samePlatform(left: PlatformConnection, right: PlatformConnection): boolean {
  return left.type === right.type && left.data.network === right.data.network;
}
function connectionEntry(
  metadata: UnknownRecord,
  identity: ConnectionOperationIdentity,
): {
  access: AccessRequest;
  login: LoginCredentials;
  labels: Record<string, string>;
  platform: PlatformConnection;
} {
  if (!isRecord(metadata.connections) || !Array.isArray(metadata.connections.create))
    throw recovery();
  const entries = metadata.connections.create;
  if (entries.length !== 1 || !isRecord(entries[0]) || entries[0].name !== 'postgres-connection')
    throw recovery();
  const entry = entries[0];
  if (
    entry.manager !== identity.callerId ||
    !isRecord(entry.resource) ||
    entry.resource.id !== identity.resourceId ||
    !isRecord(entry.metadata)
  )
    throw recovery();
  const config = entry.metadata;
  if (
    config.host !== 'postgres' ||
    config.port !== 5432 ||
    typeof config.username !== 'string' ||
    !USERNAME.test(config.username) ||
    typeof config.password !== 'string' ||
    !nonBlank(config.password) ||
    !validAccess(config.access)
  )
    throw recovery();
  const access = config.access;
  const expectedDatabase = access.scope === 'database' ? access.database : 'postgres';
  if (config.database !== expectedDatabase) throw recovery();
  const labels = labelsOf(entry.labels);
  const callerLabels: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels))
    if (key !== 'postgres.access' && key !== 'postgres.database') callerLabels[key] = value;
  if (!sameLabels(labels, connectionLabels(access, callerLabels))) throw recovery();
  return {
    access,
    login: { username: config.username, password: config.password },
    labels,
    platform: validatePlatform(config.platform_connection),
  };
}
function validateProvisionHook(
  metadata: UnknownRecord,
  access: AccessRequest,
  resourceId: string,
): void {
  if (access.scope === 'full') {
    if (metadata.object_hooks !== undefined) throw recovery();
    return;
  }
  if (!Array.isArray(metadata.object_hooks) || metadata.object_hooks.length !== 1) throw recovery();
  const hook = metadata.object_hooks[0];
  if (
    !isRecord(hook) ||
    hook.kind !== 'connection' ||
    hook.name !== 'postgres-connection' ||
    !isRecord(hook.create) ||
    !isRecord(hook.create.before) ||
    hook.create.before.query !== CATALOG_UPSERT_QUERY ||
    !isRecord(hook.create.before.bindings)
  )
    throw recovery();
  const bindings = hook.create.before.bindings;
  if (
    bindings.record_id !== catalogRecordId(resourceId, access.database) ||
    bindings.resource_id !== resourceId ||
    bindings.name !== access.database ||
    bindings.origin !== (access.operation === 'create' ? 'managed' : 'pre-existing') ||
    Object.keys(bindings).length !== 4
  )
    throw recovery();
}
function validateCleanupHook(
  metadata: UnknownRecord,
  access: AccessRequest,
  resourceId: string,
): void {
  if (access.scope !== 'database' || access.operation !== 'create') {
    if (metadata.object_hooks !== undefined) throw recovery();
    return;
  }
  if (!Array.isArray(metadata.object_hooks) || metadata.object_hooks.length !== 1) throw recovery();
  const hook = metadata.object_hooks[0];
  if (
    !isRecord(hook) ||
    hook.kind !== 'container' ||
    hook.name !== 'postgres-admin' ||
    !isRecord(hook.remove) ||
    !isRecord(hook.remove.after) ||
    hook.remove.after.query !== CATALOG_DELETE_QUERY ||
    !isRecord(hook.remove.after.bindings) ||
    hook.remove.after.bindings.record_id !== catalogRecordId(resourceId, access.database) ||
    Object.keys(hook.remove.after.bindings).length !== 1
  )
    throw recovery();
}
function identityOf(note: ConnectionNote): ConnectionOperationIdentity {
  return { operationId: note.operationId, callerId: note.callerId, resourceId: note.resourceId };
}
function provisionRecord(base: Omit<ProvisionRunRecord, 'logical'>): ProvisionRunRecord {
  const result = base as ProvisionRunRecord;
  Object.defineProperty(result, 'logical', {
    value: {
      database: base.access.scope === 'database' ? base.access.database : 'postgres',
      username: base.login.username,
      password: base.login.password,
    },
    enumerable: false,
  });
  return result;
}
function cleanupRecord(base: Omit<CleanupRunRecord, 'database' | 'username'>): CleanupRunRecord {
  const result = base as CleanupRunRecord;
  Object.defineProperties(result, {
    database: {
      value: base.access.scope === 'database' ? base.access.database : 'postgres',
      enumerable: false,
    },
    username: { value: base.login.username, enumerable: false },
  });
  return result;
}
function legacyRecord(
  parsed: ReturnType<typeof readRun>,
  target: ReturnType<typeof readTarget>,
  requirePassword: boolean,
): { access: AccessRequest; login: LoginCredentials; labels: Record<string, string> } {
  if (!GENERATED_DATABASE.test(target.database)) throw recovery();
  const service = readService(parsed.metadata);
  validateAdminEnvironment(service.environment);
  if (service.environment.ACCESS_MODE !== undefined) throw recovery();
  if (requirePassword && target.password === undefined) throw recovery();
  return {
    access: { scope: 'database', operation: 'create', database: target.database },
    login: { username: target.username, password: target.password ?? '' },
    labels: { 'postgres.access': 'database', 'postgres.database': target.database },
  };
}

export function parseProvisionRun(value: unknown): ProvisionRunRecord {
  const parsed = readRun(value, 'create-connection');
  const identity = identityOf(parsed.note);
  if (!isRecord(parsed.metadata)) throw recovery();
  const metadata = parsed.metadata;
  const service = readService(metadata);
  const target = readTarget(service.environment);
  if (parsed.noteText.startsWith('postgres-provision:v1:')) {
    const legacy = legacyRecord(parsed, target, true);
    return provisionRecord({ identity, runId: parsed.run.id, status: parsed.status, ...legacy });
  }
  const connection = connectionEntry(metadata, identity);
  if (
    target.password === undefined ||
    target.username !== connection.login.username ||
    target.password !== connection.login.password ||
    target.database !==
      (connection.access.scope === 'database' ? connection.access.database : 'postgres') ||
    service.environment.ACCESS_MODE !== expectedMode(connection.access)
  )
    throw recovery();
  if (!Array.isArray(service.connections) || service.connections.length !== 1) throw recovery();
  const servicePlatform = validatePlatform(service.connections[0]);
  if (!samePlatform(servicePlatform, connection.platform)) throw recovery();
  validateAdminEnvironment(service.environment);
  validateProvisionHook(metadata, connection.access, identity.resourceId);
  return provisionRecord({
    identity,
    runId: parsed.run.id,
    status: parsed.status,
    access: connection.access,
    login: connection.login,
    labels: connection.labels,
  });
}

export function parseCleanupRun(value: unknown): CleanupRunRecord {
  const parsed = readRun(value, 'cleanup-connection');
  const identity = identityOf(parsed.note);
  if (!isRecord(parsed.metadata)) throw recovery();
  const metadata = parsed.metadata;
  const service = readService(metadata);
  const target = readTarget(service.environment);
  if (parsed.noteText.startsWith('postgres-cleanup:v1:')) {
    const legacy = legacyRecord(parsed, target, false);
    return cleanupRecord({ identity, runId: parsed.run.id, status: parsed.status, ...legacy });
  }
  validateAdminEnvironment(service.environment);
  if (!Array.isArray(service.connections) || service.connections.length !== 1) throw recovery();
  validatePlatform(service.connections[0]);
  const mode = service.environment.ACCESS_MODE;
  let access: AccessRequest;
  if (mode === 'create-database' || mode === 'existing-database')
    access = {
      scope: 'database',
      operation: mode === 'create-database' ? 'create' : 'existing',
      database: target.database,
    };
  else if (mode === 'full-constrained' || mode === 'full-superuser') {
    if (target.database !== 'postgres') throw recovery();
    access = { scope: 'full', superuser: mode === 'full-superuser' };
  } else throw recovery();
  validateCleanupScript(service.command, access);
  validateCleanupHook(metadata, access, identity.resourceId);
  if (target.password === undefined) throw recovery();
  return cleanupRecord({
    identity,
    runId: parsed.run.id,
    status: parsed.status,
    access,
    login: { username: target.username, password: target.password },
    labels: connectionLabels(access, {}),
  });
}

function validateCleanupScript(command: string, access: AccessRequest): void {
  const hasDatabaseDrop = /\bDROP\s+DATABASE\b/i.test(command);
  const createsDatabase = access.scope === 'database' && access.operation === 'create';
  if (hasDatabaseDrop !== createsDatabase) throw recovery();

  const required = createsDatabase
    ? [
        /ALTER\s+DATABASE/,
        /pg_terminate_backend/,
        /DROP\s+DATABASE/,
        /REASSIGN\s+OWNED\s+BY/,
        /DROP\s+OWNED\s+BY/,
        /DROP\s+ROLE/,
      ]
    : [
        /database_list\s*=\s*\$?\(\s*mktemp\s*\)/,
        /has_database_privilege\s*\(/,
        /REASSIGN\s+OWNED\s+BY/,
        /DROP\s+OWNED\s+BY/,
        /DROP\s+ROLE/,
      ];
  if (required.some((pattern) => !pattern.test(command))) throw recovery();
}
