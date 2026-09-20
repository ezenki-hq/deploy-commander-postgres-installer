import { PostgresRequestError } from './errors';

export type DatabaseAccess = {
  scope: 'database';
  operation: 'create' | 'existing';
  database: string;
};

export type FullAccess = {
  scope: 'full';
  superuser: boolean;
};

export type AccessRequest = DatabaseAccess | FullAccess;

export type ParsedCreateRequest = {
  action: 'create-connection';
  requestedAccess: AccessRequest | null;
  labels: Record<string, string>;
};

export type ParsedDeleteRequest = {
  action: 'delete-connection';
  connectionId: string | null;
};

const RESERVED_LABELS = new Set([
  'postgres.access',
  'postgres.database',
  'postgres.database-origin',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new PostgresRequestError(400, message);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new PostgresRequestError(400, 'Unknown PostgreSQL request field');
  }
}

function parseLabels(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  assertRecord(value, 'PostgreSQL labels must be an object');
  const labels: Record<string, string> = {};
  for (const [key, labelValue] of Object.entries(value)) {
    if (!key.trim() || RESERVED_LABELS.has(key.trim())) {
      throw new PostgresRequestError(400, 'PostgreSQL reserved labels cannot be supplied');
    }
    if (typeof labelValue !== 'string') {
      throw new PostgresRequestError(400, 'PostgreSQL label values must be strings');
    }
    labels[key] = labelValue;
  }
  return labels;
}

function parseDatabase(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new PostgresRequestError(400, 'Invalid PostgreSQL database name');
  }
  const normalized = value.toLowerCase();
  if (normalized === 'template0' || normalized === 'template1') {
    throw new PostgresRequestError(400, 'Invalid PostgreSQL database name');
  }
  if (new TextEncoder().encode(value).byteLength > 63) {
    throw new PostgresRequestError(400, 'Invalid PostgreSQL database name');
  }
  return value;
}

export function parseCreateRequest(value: unknown): ParsedCreateRequest {
  assertRecord(value, 'PostgreSQL connection request must be an object');
  if (value.action !== 'create-connection') {
    throw new PostgresRequestError(400, 'Unsupported PostgreSQL action');
  }
  assertExactKeys(value, ['action', 'scope', 'operation', 'database', 'superuser', 'labels']);
  const labels = parseLabels(value.labels);

  if (value.scope === undefined) {
    if (Object.keys(value).some((key) => key !== 'action' && key !== 'labels')) {
      throw new PostgresRequestError(400, 'Incomplete PostgreSQL access request');
    }
    return { action: 'create-connection', requestedAccess: null, labels };
  }

  if (value.scope === 'database') {
    if (
      (value.operation !== 'create' && value.operation !== 'existing') ||
      value.superuser !== undefined
    ) {
      throw new PostgresRequestError(400, 'Invalid PostgreSQL database access request');
    }
    return {
      action: 'create-connection',
      requestedAccess: {
        scope: 'database',
        operation: value.operation,
        database: parseDatabase(value.database),
      },
      labels,
    };
  }

  if (
    value.scope === 'full' &&
    typeof value.superuser === 'boolean' &&
    value.operation === undefined &&
    value.database === undefined
  ) {
    return {
      action: 'create-connection',
      requestedAccess: { scope: 'full', superuser: value.superuser },
      labels,
    };
  }

  throw new PostgresRequestError(400, 'Invalid PostgreSQL access request');
}

export function parseDeleteRequest(value: unknown): ParsedDeleteRequest {
  assertRecord(value, 'PostgreSQL delete request must be an object');
  if (value.action !== 'delete-connection') {
    throw new PostgresRequestError(400, 'Unsupported PostgreSQL action');
  }
  assertExactKeys(value, ['action', 'connection']);
  if (value.connection === undefined) return { action: 'delete-connection', connectionId: null };
  if (typeof value.connection !== 'string' || value.connection.trim() === '') {
    throw new PostgresRequestError(400, 'Invalid PostgreSQL connection ID');
  }
  return { action: 'delete-connection', connectionId: value.connection };
}

export { RESERVED_LABELS };
