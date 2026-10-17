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
  resourceId: string;
  requestedAccess: AccessRequest | null;
  labels: Record<string, string>;
};

export type ParsedLinkRequest = {
  action: 'link-connection';
  resourceId: string;
  connectionId: string;
  labels: Record<string, string>;
};

export type ParsedUnlinkRequest = {
  action: 'unlink-connection';
  resourceId: string;
  connectionId: string;
  groupId: string;
};

export type ParsedDeleteRequest =
  | { action: 'delete-connection'; connectionId: string | null }
  | { action: 'delete-connection'; connectionIds: string[] };

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

function parseRequiredId(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PostgresRequestError(400, message);
  }
  return value.trim();
}

function validateCreateGroupLabels(labels: Record<string, string>): void {
  const groupId = labels.custom_deployer_group_id;
  const origin = labels.custom_deployer_connection_origin;
  if (groupId === undefined && origin === undefined) return;
  if (
    typeof groupId !== 'string' ||
    groupId.trim() === '' ||
    origin !== 'created'
  ) {
    throw new PostgresRequestError(400, 'Invalid Custom Deployer connection labels');
  }
}

function validateLinkLabels(labels: Record<string, string>): void {
  if (
    typeof labels.custom_deployer_group_id !== 'string' ||
    labels.custom_deployer_group_id.trim() === '' ||
    labels.custom_deployer_connection_origin !== 'imported'
  ) {
    throw new PostgresRequestError(400, 'Invalid Custom Deployer connection labels');
  }
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
  const resourceId = parseRequiredId(value.resource, 'A PostgreSQL resource is required');
  const labels = parseLabels(value.labels);
  validateCreateGroupLabels(labels);

  if (value.scope === undefined) {
    if (
      value.operation !== undefined ||
      value.database !== undefined ||
      value.superuser !== undefined
    ) {
      throw new PostgresRequestError(400, 'Incomplete PostgreSQL access request');
    }
    return { action: 'create-connection', resourceId, requestedAccess: null, labels };
  }

  if (value.scope === 'database') {
    if (value.operation !== 'create' && value.operation !== 'existing') {
      throw new PostgresRequestError(400, 'Invalid PostgreSQL database access request');
    }
    return {
      action: 'create-connection',
      resourceId,
      requestedAccess: {
        scope: 'database',
        operation: value.operation,
        database: parseDatabase(value.database),
      },
      labels,
    };
  }

  if (value.scope === 'full') {
    if (value.superuser !== undefined && typeof value.superuser !== 'boolean') {
      throw new PostgresRequestError(400, 'Invalid PostgreSQL access request');
    }
    return {
      action: 'create-connection',
      resourceId,
      requestedAccess: { scope: 'full', superuser: value.superuser ?? false },
      labels,
    };
  }

  throw new PostgresRequestError(400, 'Invalid PostgreSQL access request');
}

export function parseLinkRequest(value: unknown): ParsedLinkRequest {
  assertRecord(value, 'PostgreSQL link request must be an object');
  assertExactKeys(value, ['action', 'resource', 'connection', 'labels']);
  if (value.action !== 'link-connection') {
    throw new PostgresRequestError(400, 'Unsupported PostgreSQL action');
  }
  const labels = parseLabels(value.labels);
  validateLinkLabels(labels);
  return {
    action: 'link-connection',
    resourceId: parseRequiredId(value.resource, 'A PostgreSQL resource is required'),
    connectionId: parseRequiredId(value.connection, 'A PostgreSQL connection is required'),
    labels,
  };
}

export function parseUnlinkRequest(value: unknown): ParsedUnlinkRequest {
  assertRecord(value, 'PostgreSQL unlink request must be an object');
  assertExactKeys(value, ['action', 'resource', 'connection', 'group']);
  if (value.action !== 'unlink-connection') {
    throw new PostgresRequestError(400, 'Unsupported PostgreSQL action');
  }
  return {
    action: 'unlink-connection',
    resourceId: parseRequiredId(value.resource, 'A PostgreSQL resource is required'),
    connectionId: parseRequiredId(value.connection, 'A PostgreSQL connection is required'),
    groupId: parseRequiredId(value.group, 'A deployment group is required'),
  };
}

export function parseDeleteRequest(value: unknown): ParsedDeleteRequest {
  assertRecord(value, 'PostgreSQL delete request must be an object');
  if (value.action !== 'delete-connection') {
    throw new PostgresRequestError(400, 'Unsupported PostgreSQL action');
  }
  assertExactKeys(value, ['action', 'connection', 'connections']);
  if (value.connection !== undefined && value.connections !== undefined) {
    throw new PostgresRequestError(400, 'Specify either connection or connections');
  }
  if (value.connections !== undefined) {
    if (!Array.isArray(value.connections) || value.connections.length === 0) {
      throw new PostgresRequestError(400, 'PostgreSQL connections must be a non-empty array');
    }
    const connectionIds = value.connections.map((id) => {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new PostgresRequestError(400, 'Invalid PostgreSQL connection ID');
      }
      return id;
    });
    if (new Set(connectionIds).size !== connectionIds.length) {
      throw new PostgresRequestError(400, 'PostgreSQL connection IDs must be unique');
    }
    return { action: 'delete-connection', connectionIds };
  }
  if (value.connection === undefined) return { action: 'delete-connection', connectionId: null };
  if (typeof value.connection !== 'string' || value.connection.trim() === '') {
    throw new PostgresRequestError(400, 'Invalid PostgreSQL connection ID');
  }
  return { action: 'delete-connection', connectionId: value.connection };
}

export { RESERVED_LABELS };
