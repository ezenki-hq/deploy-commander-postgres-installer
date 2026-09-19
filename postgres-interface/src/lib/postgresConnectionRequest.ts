import { PostgresRequestError } from './postgresErrors';

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

export interface ParsedConnectionRequest {
  access: AccessRequest | null;
  labels: Record<string, string>;
}

export const RESERVED_CONNECTION_LABELS = new Set(['postgres.access', 'postgres.database']);

type RequestRecord = Record<string, unknown>;
type RandomBytes = (length: number) => Uint8Array;

const own = (value: RequestRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is RequestRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (detail: string): never => {
  throw new PostgresRequestError(400, `Invalid PostgreSQL connection request: ${detail}`);
};

const hasOnlyKeys = (value: RequestRecord, allowed: readonly string[]): boolean => {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
};

const parseLabels = (value: unknown): Record<string, string> => {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return invalid('labels must be an object');
  }

  const labels: Record<string, string> = {};
  for (const [rawKey, labelValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (key.length === 0) {
      invalid('label keys must not be empty');
    }
    if (Object.prototype.hasOwnProperty.call(labels, key)) {
      invalid(`duplicate label key after trimming: ${rawKey}`);
    }
    if (RESERVED_CONNECTION_LABELS.has(key)) {
      invalid(`label is reserved: ${key}`);
    }
    if (typeof labelValue !== 'string') {
      return invalid(`label values must be strings: ${key}`);
    }
    Object.defineProperty(labels, key, {
      configurable: true,
      enumerable: true,
      value: labelValue,
      writable: true,
    });
  }
  return labels;
};

const parseDatabaseName = (value: unknown): string => {
  if (typeof value !== 'string') {
    return invalid('database must be a string');
  }
  if (value.length === 0) {
    return invalid('database must not be empty');
  }
  if (value.includes('\0')) {
    return invalid('database must not contain NUL');
  }
  if (value.toLowerCase() === 'template0' || value.toLowerCase() === 'template1') {
    return invalid('database must not be a PostgreSQL template database');
  }
  if (new TextEncoder().encode(value).length > 63) {
    return invalid('database must be at most 63 UTF-8 bytes');
  }
  return value;
};

export const parseConnectionRequest = (value: unknown): ParsedConnectionRequest => {
  if (!isRecord(value) || !own(value, 'action') || value.action !== 'create-connection') {
    return invalid('action must be create-connection');
  }

  const labels = parseLabels(value.labels);
  if (!own(value, 'scope')) {
    if (!hasOnlyKeys(value, ['action', 'labels'])) {
      return invalid('labels-only requests may not contain access fields');
    }
    return { labels, access: null };
  }

  if (value.scope === 'database') {
    if (!hasOnlyKeys(value, ['action', 'labels', 'scope', 'operation', 'database'])) {
      return invalid('database requests contain unsupported fields');
    }
    if (value.operation !== 'create' && value.operation !== 'existing') {
      return invalid('database operation must be create or existing');
    }
    if (!own(value, 'database')) {
      return invalid('database requests require a database name');
    }
    return {
      labels,
      access: {
        scope: 'database',
        operation: value.operation,
        database: parseDatabaseName(value.database),
      },
    };
  }

  if (value.scope === 'full') {
    if (!hasOnlyKeys(value, ['action', 'labels', 'scope', 'superuser'])) {
      return invalid('full requests contain unsupported fields');
    }
    if (typeof value.superuser !== 'boolean') {
      return invalid('full requests require a boolean superuser value');
    }
    return {
      labels,
      access: { scope: 'full', superuser: value.superuser },
    };
  }

  return invalid('scope must be database or full');
};

export const generateDatabaseName = (
  random: RandomBytes = (length) => {
    const bytes = new Uint8Array(length);
    if (typeof globalThis.crypto?.getRandomValues !== 'function') {
      throw new Error('Secure random number generation is unavailable');
    }
    return globalThis.crypto.getRandomValues(bytes);
  },
): string => {
  const bytes = random(16);
  if (bytes.length !== 16) {
    throw new Error('Database name generator must return exactly 16 bytes');
  }
  return `db_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

export const connectionLabels = (
  access: AccessRequest,
  callerLabels: Record<string, string>,
): Record<string, string> => {
  const labels = parseLabels(callerLabels);
  labels['postgres.access'] = access.scope;
  if (access.scope === 'database') {
    labels['postgres.database'] = access.database;
  }
  return labels;
};

export const sameLabels = (
  left: Record<string, string>,
  right: Record<string, string>,
): boolean => {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key],
  );
};
