import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import type { LogicalCredentials } from './credentials';
import { PostgresRecoveryRequiredError } from './postgresErrors';

export type RunStatus = 0 | 1 | 2 | 3;
export interface ConnectionOperationIdentity { operationId: string; callerId: string; resourceId: string; }
export interface ProvisionRunRecord { identity: ConnectionOperationIdentity; runId: string; status: RunStatus; logical: LogicalCredentials; }
export interface CleanupRunRecord { identity: ConnectionOperationIdentity; runId: string; status: RunStatus; database: string; username: string; }
export type ConnectionNote = ({ kind: 'provision' } | { kind: 'cleanup' }) & ConnectionOperationIdentity;

const OPERATION_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const DATABASE = /^db_[0-9a-f]{32}$/;
const USERNAME = /^pg_user_[0-9a-f]{32}$/;
type UnknownRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is UnknownRecord => typeof v === 'object' && v !== null && !Array.isArray(v);
const recovery = (): PostgresRecoveryRequiredError => new PostgresRecoveryRequiredError();
const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function validIdentity(identity: ConnectionOperationIdentity): void {
  if (!isRecord(identity) || !nonBlank(identity.callerId) || !nonBlank(identity.resourceId) || !nonBlank(identity.operationId) || !OPERATION_ID.test(identity.operationId)) throw recovery();
}
function makeNote(kind: 'provision' | 'cleanup', identity: ConnectionOperationIdentity): string {
  validIdentity(identity);
  return `postgres-${kind}:v1:${encodeURIComponent(identity.callerId)}:${encodeURIComponent(identity.resourceId)}:${identity.operationId}`;
}
export const makeProvisionNote = (identity: ConnectionOperationIdentity): string => makeNote('provision', identity);
export const makeCleanupNote = (identity: ConnectionOperationIdentity): string => makeNote('cleanup', identity);

export function parseConnectionNote(note: unknown): ConnectionNote {
  if (typeof note !== 'string') throw recovery();
  const fields = note.split(':');
  if (fields.length !== 5 || (fields[0] !== 'postgres-provision' && fields[0] !== 'postgres-cleanup') || fields[1] !== 'v1' || !nonBlank(fields[2]) || !nonBlank(fields[3]) || !OPERATION_ID.test(fields[4])) throw recovery();
  let callerId: string; let resourceId: string;
  try { callerId = decodeURIComponent(fields[2]); resourceId = decodeURIComponent(fields[3]); } catch { throw recovery(); }
  const identity = { operationId: fields[4], callerId, resourceId };
  validIdentity(identity);
  return { kind: fields[0] === 'postgres-provision' ? 'provision' : 'cleanup', ...identity };
}

function isStatus(value: unknown): value is RunStatus { return value === 0 || value === 1 || value === 2 || value === 3; }
function readRun(value: unknown, expectedAction: 'create-connection' | 'cleanup-connection') {
  if (!isRecord(value) || !isRecord(value.run) || !isRecord(value.config)) throw recovery();
  const run = value.run; const config = value.config;
  if (!nonBlank(run.id) || run.action !== expectedAction || !nonBlank(run.note) || !nonBlank(run.created_at) || !nonBlank(run.queued_at) || !nonBlank(run.updated_at) || !isStatus(run.status) || config.run !== run.id || config.action !== expectedAction) throw recovery();
  const note = parseConnectionNote(run.note);
  if (note.kind !== (expectedAction === 'create-connection' ? 'provision' : 'cleanup')) throw recovery();
  const metadata = config.metadata;
  if (!isRecord(metadata) || !isRecord(metadata.services)) throw recovery();
  const service = metadata.services['postgres-admin'];
  if (!isRecord(service) || service.role !== 'runner' || !isRecord(service.environment)) throw recovery();
  return { run: run as unknown as RPC.RunItem, note, environment: service.environment, status: run.status as RunStatus };
}
function readTarget(environment: UnknownRecord): { database: string; username: string } {
  if (typeof environment.TARGET_DATABASE !== 'string' || !DATABASE.test(environment.TARGET_DATABASE) || typeof environment.TARGET_USERNAME !== 'string' || !USERNAME.test(environment.TARGET_USERNAME)) throw recovery();
  return { database: environment.TARGET_DATABASE, username: environment.TARGET_USERNAME };
}
const identityOf = (note: ConnectionNote): ConnectionOperationIdentity => ({ operationId: note.operationId, callerId: note.callerId, resourceId: note.resourceId });

export function parseProvisionRun(value: unknown): ProvisionRunRecord {
  const parsed = readRun(value, 'create-connection'); const target = readTarget(parsed.environment);
  if (typeof parsed.environment.TARGET_PASSWORD !== 'string' || parsed.environment.TARGET_PASSWORD.trim().length === 0) throw recovery();
  return { identity: identityOf(parsed.note), runId: parsed.run.id, status: parsed.status, logical: { ...target, password: parsed.environment.TARGET_PASSWORD } };
}
export function parseCleanupRun(value: unknown): CleanupRunRecord {
  const parsed = readRun(value, 'cleanup-connection');
  return { identity: identityOf(parsed.note), runId: parsed.run.id, status: parsed.status, ...readTarget(parsed.environment) };
}
