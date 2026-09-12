import type { RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import { OperationBusyError } from './postgresErrors';

export type OperationKind = 'connection' | 'teardown';

export type OperationPhase =
  | 'prepared'
  | 'provision-starting'
  | 'provision-running'
  | 'provisioned'
  | 'persisting'
  | 'reconciliation-required'
  | 'cleanup-required'
  | 'cleanup-starting'
  | 'cleanup-running'
  | 'teardown-starting'
  | 'teardown-running'
  | 'teardown-release-required';

export type CleanupReason =
  | 'provision-failed'
  | 'duplicate-race'
  | 'persistence-failed'
  | 'abandoned';

export interface ConnectionOperation {
  kind: 'connection';
  operationId: string;
  callerId: string;
  resourceId: string;
  database: string;
  username: string;
  phase: Extract<OperationPhase,
    'prepared' | 'provision-starting' | 'provision-running' | 'provisioned'
    | 'persisting' | 'reconciliation-required' | 'cleanup-required'
    | 'cleanup-starting' | 'cleanup-running'>;
  cleanupReason: CleanupReason | null;
  provisionRunId: string | null;
  cleanupRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeardownOperation {
  kind: 'teardown';
  operationId: string;
  resourceId: string;
  phase: Extract<OperationPhase,
    'teardown-starting' | 'teardown-running' | 'teardown-release-required'>;
  teardownRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OperationRecord = ConnectionOperation | TeardownOperation;

export interface OperationTransition {
  phase: OperationPhase;
  cleanupReason?: CleanupReason | null;
  provisionRunId?: string | null;
  cleanupRunId?: string | null;
  teardownRunId?: string | null;
  updatedAt?: string;
}

type UnknownRecord = Record<string, unknown>;

const CONNECTION_PHASES: readonly OperationPhase[] = [
  'prepared',
  'provision-starting',
  'provision-running',
  'provisioned',
  'persisting',
  'reconciliation-required',
  'cleanup-required',
  'cleanup-starting',
  'cleanup-running',
];

const TEARDOWN_PHASES: readonly OperationPhase[] = [
  'teardown-starting',
  'teardown-running',
  'teardown-release-required',
];

const CLEANUP_REASONS: readonly CleanupReason[] = [
  'provision-failed',
  'duplicate-race',
  'persistence-failed',
  'abandoned',
];

const OPERATION_RECORD_KEYS = new Set([
  'kind',
  'operation_id',
  'caller_id',
  'resource_id',
  'database',
  'username',
  'phase',
  'cleanup_reason',
  'provision_run_id',
  'cleanup_run_id',
  'teardown_run_id',
  'created_at',
  'updated_at',
]);

const LEGAL_TRANSITIONS: Readonly<Record<OperationPhase, readonly OperationPhase[]>> = {
  prepared: ['provision-starting'],
  'provision-starting': ['provision-running'],
  'provision-running': ['provisioned', 'cleanup-required'],
  provisioned: ['persisting', 'cleanup-required'],
  persisting: ['reconciliation-required'],
  'reconciliation-required': ['cleanup-required'],
  'cleanup-required': ['cleanup-starting'],
  'cleanup-starting': ['cleanup-running', 'cleanup-required'],
  'cleanup-running': ['cleanup-required', 'cleanup-running'],
  'teardown-starting': ['teardown-running', 'teardown-release-required'],
  'teardown-running': ['teardown-release-required'],
  'teardown-release-required': [],
};

const CREATE_CONNECTION_QUERY = `CREATE postgres_operation:current CONTENT {
  kind: $kind, operation_id: $operation_id,
  caller_id: $caller_id, resource_id: $resource_id,
  database: $database, username: $username,
  phase: $phase, cleanup_reason: $cleanup_reason,
  provision_run_id: $provision_run_id, cleanup_run_id: $cleanup_run_id,
  created_at: $created_at, updated_at: $updated_at
} RETURN VALUE operation_id;`;

const CREATE_TEARDOWN_QUERY = `CREATE postgres_operation:current CONTENT {
  kind: $kind, operation_id: $operation_id,
  resource_id: $resource_id, phase: $phase,
  teardown_run_id: $teardown_run_id,
  created_at: $created_at, updated_at: $updated_at
} RETURN VALUE operation_id;`;

const READ_QUERY = `SELECT kind, operation_id, caller_id, resource_id,
  database, username, phase, cleanup_reason,
  provision_run_id, cleanup_run_id, teardown_run_id,
  created_at, updated_at FROM postgres_operation:current;`;

const DELETE_QUERY = 'DELETE postgres_operation:current WHERE operation_id = $operation_id RETURN VALUE operation_id;';

export class OperationDatabaseError extends Error {
  constructor() {
    super('PostgreSQL operation database operation failed');
    this.name = 'OperationDatabaseError';
  }
}

class JournalDatabaseError extends Error {
  constructor() {
    super('Journal database operation failed');
    this.name = 'JournalDatabaseError';
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isNonBlankString(value);
}

function isOperationPhase(value: unknown): value is OperationPhase {
  return typeof value === 'string'
    && (CONNECTION_PHASES.includes(value as OperationPhase)
      || TEARDOWN_PHASES.includes(value as OperationPhase));
}

function isCleanupReason(value: unknown): value is CleanupReason | null {
  return value === null || (typeof value === 'string' && CLEANUP_REASONS.includes(value as CleanupReason));
}

function hasForbiddenField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => /password|secret/i.test(key) || hasForbiddenField(child));
}

function hasUnexpectedRecordField(value: UnknownRecord): boolean {
  return Object.keys(value).some((key) => !OPERATION_RECORD_KEYS.has(key));
}

function assertOperationId(operationId: unknown): asserts operationId is string {
  if (!isNonBlankString(operationId)) throw new Error('Invalid PostgreSQL operation');
}

function assertConnectionOperation(operation: unknown): asserts operation is ConnectionOperation {
  if (!isRecord(operation)
    || hasForbiddenField(operation)
    || operation.kind !== 'connection'
    || !isNonBlankString(operation.operationId)
    || !isNonBlankString(operation.callerId)
    || !isNonBlankString(operation.resourceId)
    || !isNonBlankString(operation.database)
    || !isNonBlankString(operation.username)
    || !CONNECTION_PHASES.includes(operation.phase as OperationPhase)
    || !isCleanupReason(operation.cleanupReason)
    || !isNullableString(operation.provisionRunId)
    || !isNullableString(operation.cleanupRunId)
    || !isNonBlankString(operation.createdAt)
    || !isNonBlankString(operation.updatedAt)) {
    throw new Error('Invalid PostgreSQL operation');
  }
}

function assertTeardownOperation(operation: unknown): asserts operation is TeardownOperation {
  if (!isRecord(operation)
    || hasForbiddenField(operation)
    || operation.kind !== 'teardown'
    || !isNonBlankString(operation.operationId)
    || !isNonBlankString(operation.resourceId)
    || !TEARDOWN_PHASES.includes(operation.phase as OperationPhase)
    || !isNullableString(operation.teardownRunId)
    || !isNonBlankString(operation.createdAt)
    || !isNonBlankString(operation.updatedAt)) {
    throw new Error('Invalid PostgreSQL operation');
  }
}

function assertOperation(operation: unknown): asserts operation is OperationRecord {
  if (isRecord(operation) && operation.kind === 'connection') {
    assertConnectionOperation(operation);
  } else {
    assertTeardownOperation(operation);
  }
}

function parseStoredOperation(value: unknown): OperationRecord | null {
  if (!Array.isArray(value)) throw new Error('Invalid PostgreSQL operation result');
  if (value.length === 0) return null;
  if (value.length !== 1 || !isRecord(value[0])
    || hasForbiddenField(value[0]) || hasUnexpectedRecordField(value[0])) {
    throw new Error('Invalid PostgreSQL operation result');
  }

  const record = value[0];
  if (record.kind === 'connection') {
    if (!isNonBlankString(record.operation_id)
      || !isNonBlankString(record.caller_id)
      || !isNonBlankString(record.resource_id)
      || !isNonBlankString(record.database)
      || !isNonBlankString(record.username)
      || !CONNECTION_PHASES.includes(record.phase as OperationPhase)
      || !isCleanupReason(record.cleanup_reason)
      || !isNullableString(record.provision_run_id)
      || !isNullableString(record.cleanup_run_id)
      || !isNonBlankString(record.created_at)
      || !isNonBlankString(record.updated_at)
      || (record.teardown_run_id !== undefined && record.teardown_run_id !== null)) {
      throw new Error('Invalid PostgreSQL operation result');
    }
    return {
      kind: 'connection',
      operationId: record.operation_id,
      callerId: record.caller_id,
      resourceId: record.resource_id,
      database: record.database,
      username: record.username,
      phase: record.phase as ConnectionOperation['phase'],
      cleanupReason: record.cleanup_reason,
      provisionRunId: record.provision_run_id,
      cleanupRunId: record.cleanup_run_id,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }

  if (record.kind === 'teardown'
    && isNonBlankString(record.operation_id)
    && isNonBlankString(record.resource_id)
    && TEARDOWN_PHASES.includes(record.phase as OperationPhase)
    && isNullableString(record.teardown_run_id)
    && isNonBlankString(record.created_at)
    && isNonBlankString(record.updated_at)
    && (record.caller_id === undefined || record.caller_id === null)
    && (record.database === undefined || record.database === null)
    && (record.username === undefined || record.username === null)
    && (record.cleanup_reason === undefined || record.cleanup_reason === null)
    && (record.provision_run_id === undefined || record.provision_run_id === null)
    && (record.cleanup_run_id === undefined || record.cleanup_run_id === null)) {
    return {
      kind: 'teardown',
      operationId: record.operation_id,
      resourceId: record.resource_id,
      phase: record.phase as TeardownOperation['phase'],
      teardownRunId: record.teardown_run_id,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }

  throw new Error('Invalid PostgreSQL operation result');
}

async function runQuery(
  caller: RPCCaller,
  query: string,
  bindings?: Record<string, unknown>,
): Promise<unknown> {
  let response: unknown;
  try {
    response = bindings === undefined
      ? await caller.databaseQuery(query)
      : await caller.databaseQuery(query, bindings);
  } catch {
    throw new JournalDatabaseError();
  }
  if (!isRecord(response)
    || !Array.isArray(response.results)
    || response.results.length !== 1
    || !isRecord(response.results[0])
    || response.results[0].statement !== 0
    || response.results[0].status !== 'OK'
    || typeof response.results[0].time !== 'string'
    || !Object.prototype.hasOwnProperty.call(response.results[0], 'result')) {
    throw new JournalDatabaseError();
  }
  return response.results[0].result;
}

function assertMutationResult(result: unknown, operationId: string): void {
  if (Array.isArray(result) && result.length === 0) {
    throw new Error('PostgreSQL operation ownership was lost');
  }
  if (!Array.isArray(result) || result.length !== 1 || result[0] !== operationId) {
    throw new Error('Invalid PostgreSQL operation mutation result');
  }
}

function publicDatabaseError(): OperationDatabaseError {
  return new OperationDatabaseError();
}

export async function readOperation(caller: RPCCaller): Promise<OperationRecord | null> {
  try {
    return parseStoredOperation(await runQuery(caller, READ_QUERY));
  } catch (error) {
    if (error instanceof JournalDatabaseError) throw publicDatabaseError();
    throw error;
  }
}

function operationBindings(operation: OperationRecord): Record<string, unknown> {
  if (operation.kind === 'connection') {
    return {
      kind: operation.kind,
      operation_id: operation.operationId,
      caller_id: operation.callerId,
      resource_id: operation.resourceId,
      database: operation.database,
      username: operation.username,
      phase: operation.phase,
      cleanup_reason: operation.cleanupReason,
      provision_run_id: operation.provisionRunId,
      cleanup_run_id: operation.cleanupRunId,
      created_at: operation.createdAt,
      updated_at: operation.updatedAt,
    };
  }
  return {
    kind: operation.kind,
    operation_id: operation.operationId,
    resource_id: operation.resourceId,
    phase: operation.phase,
    teardown_run_id: operation.teardownRunId,
    created_at: operation.createdAt,
    updated_at: operation.updatedAt,
  };
}

export async function acquireOperation(caller: RPCCaller, operation: OperationRecord): Promise<void> {
  assertOperation(operation);
  const query = operation.kind === 'connection' ? CREATE_CONNECTION_QUERY : CREATE_TEARDOWN_QUERY;
  try {
    assertMutationResult(await runQuery(caller, query, operationBindings(operation)), operation.operationId);
  } catch (error) {
    if (!(error instanceof JournalDatabaseError)) throw error;
    try {
      const existing = parseStoredOperation(await runQuery(caller, READ_QUERY));
      if (existing !== null) throw new OperationBusyError();
    } catch (readError) {
      if (readError instanceof OperationBusyError) throw readError;
      throw publicDatabaseError();
    }
    throw publicDatabaseError();
  }
}

function transitionValues(next: OperationPhase | OperationTransition): OperationTransition {
  if (typeof next === 'string') {
    if (!isOperationPhase(next)) throw new Error('Invalid PostgreSQL operation transition');
    return { phase: next, updatedAt: new Date().toISOString() };
  }
  if (!isRecord(next) || !isOperationPhase(next.phase) || hasForbiddenField(next)) {
    throw new Error('Invalid PostgreSQL operation transition');
  }
  const values: OperationTransition = {
    phase: next.phase,
    updatedAt: next.updatedAt === undefined ? new Date().toISOString() : next.updatedAt,
  };
  if (!isNonBlankString(values.updatedAt)) throw new Error('Invalid PostgreSQL operation transition');
  for (const [property, value] of [
    ['cleanupReason', next.cleanupReason],
    ['provisionRunId', next.provisionRunId],
    ['cleanupRunId', next.cleanupRunId],
    ['teardownRunId', next.teardownRunId],
  ] as const) {
    if (value !== undefined) {
      if (property === 'cleanupReason' ? !isCleanupReason(value) : !isNullableString(value)) {
        throw new Error('Invalid PostgreSQL operation transition');
      }
      values[property] = value as never;
    }
  }
  return values;
}

function assertTransitionFieldCompatibility(
  expectedPhase: OperationPhase,
  next: OperationTransition,
): void {
  const teardown = TEARDOWN_PHASES.includes(expectedPhase) || TEARDOWN_PHASES.includes(next.phase);
  if (teardown) {
    if (next.cleanupReason !== undefined
      || next.provisionRunId !== undefined
      || next.cleanupRunId !== undefined) {
      throw new Error('Invalid PostgreSQL operation transition');
    }
    return;
  }

  if (next.teardownRunId !== undefined) {
    throw new Error('Invalid PostgreSQL operation transition');
  }

  const provisionPhase = (phase: OperationPhase) => phase === 'provision-starting'
    || phase === 'provision-running' || phase === 'provisioned';
  if (next.provisionRunId !== undefined
    && !provisionPhase(expectedPhase) && !provisionPhase(next.phase)) {
    throw new Error('Invalid PostgreSQL operation transition');
  }

  const cleanupPhase = (phase: OperationPhase) => phase === 'cleanup-required'
    || phase === 'cleanup-starting' || phase === 'cleanup-running';
  if (next.cleanupRunId !== undefined
    && !cleanupPhase(expectedPhase) && !cleanupPhase(next.phase)) {
    throw new Error('Invalid PostgreSQL operation transition');
  }
}

export async function transitionOperation(
  caller: RPCCaller,
  operationId: string,
  expectedPhase: OperationPhase,
  next: OperationPhase | OperationTransition,
): Promise<void> {
  assertOperationId(operationId);
  if (!isOperationPhase(expectedPhase)) throw new Error('Invalid PostgreSQL operation transition');
  const values = transitionValues(next);
  if (!LEGAL_TRANSITIONS[expectedPhase].includes(values.phase)) {
    throw new Error('Invalid PostgreSQL operation transition');
  }
  assertTransitionFieldCompatibility(expectedPhase, values);

  const set: string[] = ['phase = $next_phase'];
  const bindings: Record<string, unknown> = {
    next_phase: values.phase,
    operation_id: operationId,
    expected_phase: expectedPhase,
    updated_at: values.updatedAt,
  };
  if (values.cleanupReason !== undefined) {
    set.push('cleanup_reason = $cleanup_reason');
    bindings.cleanup_reason = values.cleanupReason;
  }
  if (values.provisionRunId !== undefined) {
    set.push('provision_run_id = $provision_run_id');
    bindings.provision_run_id = values.provisionRunId;
  }
  if (values.cleanupRunId !== undefined) {
    set.push('cleanup_run_id = $cleanup_run_id');
    bindings.cleanup_run_id = values.cleanupRunId;
  }
  if (values.teardownRunId !== undefined) {
    set.push('teardown_run_id = $teardown_run_id');
    bindings.teardown_run_id = values.teardownRunId;
  }
  set.push('updated_at = $updated_at');
  const query = `UPDATE postgres_operation:current SET ${set.join(', ')} WHERE operation_id = $operation_id AND phase = $expected_phase RETURN VALUE operation_id;`;

  try {
    assertMutationResult(await runQuery(caller, query, bindings), operationId);
  } catch (error) {
    if (error instanceof JournalDatabaseError) throw publicDatabaseError();
    throw error;
  }
}

export async function deleteOperation(caller: RPCCaller, operationId: string): Promise<void> {
  assertOperationId(operationId);
  try {
    assertMutationResult(await runQuery(caller, DELETE_QUERY, { operation_id: operationId }), operationId);
  } catch (error) {
    if (error instanceof JournalDatabaseError) throw publicDatabaseError();
    throw error;
  }
}
