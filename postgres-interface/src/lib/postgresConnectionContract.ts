import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { PostgresRecoveryRequiredError } from './postgresErrors';
import {
  parsePlatformConnection,
  type PlatformConnection,
} from './postgresContracts';

export interface ExpectedConnectionIdentity {
  managerId: string;
  resourceId: string;
  connectionId?: string;
}

const PAGE_LIMIT = 50;
const DATABASE_PATTERN = /^db_[0-9a-f]{32}$/;
const USERNAME_PATTERN = /^dc_user_[0-9a-f]{32}$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidConnection(): PostgresRecoveryRequiredError {
  return new PostgresRecoveryRequiredError();
}

function parseAuthoritativePlatform(value: unknown): PlatformConnection {
  try {
    return parsePlatformConnection(value);
  } catch {
    throw invalidConnection();
  }
}

function validateSummary(
  value: unknown,
  expected: ExpectedConnectionIdentity,
): value is RPC.ConnectionItem {
  return isRecord(value)
    && nonBlank(value.id)
    && (!expected.connectionId || value.id === expected.connectionId)
    && nonBlank(value.manager)
    && value.manager === expected.managerId
    && nonBlank(value.resource)
    && value.resource === expected.resourceId
    && value.external === false
    && nonBlank(value.created_at)
    && nonBlank(value.updated_at);
}

function validatePage(
  value: unknown,
  expectedOffset: number,
): { items: RPC.ConnectionItem[]; limit: number; offset: number; total: number } {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(isRecord)) {
    throw invalidConnection();
  }
  if (typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit <= 0
    || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0
    || typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0) {
    throw invalidConnection();
  }
  const total = value.total;
  const offset = value.offset;
  if (offset !== expectedOffset
    || (value.items.length === 0 && total > 0)
    || value.items.length > value.limit
    || value.items.length > total
    || offset > total
    || offset + value.items.length > total
    || (value.items.length < value.limit && offset + value.items.length < total)) {
    throw invalidConnection();
  }
  return {
    items: value.items as unknown as RPC.ConnectionItem[],
    limit: value.limit,
    offset: value.offset,
    total: value.total,
  };
}

function normalizeExpected(expected: ExpectedConnectionIdentity): ExpectedConnectionIdentity {
  if (!nonBlank(expected.managerId) || !nonBlank(expected.resourceId)
    || (expected.connectionId !== undefined && !nonBlank(expected.connectionId))) {
    throw invalidConnection();
  }
  return expected;
}

export function normalizePostgresConnection(
  value: unknown,
  expected: ExpectedConnectionIdentity,
  platform: PlatformConnection,
): RPC.CreateConnection {
  const authoritativePlatform = parseAuthoritativePlatform(platform);
  const identity = normalizeExpected(expected);
  if (!isRecord(value) || !isRecord(value.connection) || !isRecord(value.config)
    || !isRecord(value.config.metadata)) {
    throw invalidConnection();
  }

  const connection = value.connection;
  const config = value.config;
  const metadata = config.metadata as UnknownRecord;
  if (!nonBlank(connection.id) || !nonBlank(config.id) || connection.id !== config.id
    || (identity.connectionId !== undefined && connection.id !== identity.connectionId)
    || !validateSummary(connection, identity)
    || !nonBlank(config.manager) || config.manager !== identity.managerId
    || !nonBlank(config.resource) || config.resource !== identity.resourceId) {
    throw invalidConnection();
  }

  if (metadata.host !== 'postgres' || metadata.port !== 5432
    || typeof metadata.database !== 'string' || !DATABASE_PATTERN.test(metadata.database)
    || typeof metadata.username !== 'string' || !USERNAME_PATTERN.test(metadata.username)
    || !nonBlank(metadata.password)) {
    throw invalidConnection();
  }

  if (Object.prototype.hasOwnProperty.call(metadata, 'platform_connection')) {
    try {
      parsePlatformConnection(metadata.platform_connection);
    } catch {
      throw invalidConnection();
    }
  }

  return {
    ...value,
    connection: { ...connection },
    config: {
      ...config,
      metadata: {
        ...metadata,
        platform_connection: authoritativePlatform,
      },
    },
  } as unknown as RPC.CreateConnection;
}

export async function findExistingConnection(
  caller: RPCCaller,
  managerId: string,
  resourceId: string,
  platform: PlatformConnection,
): Promise<RPC.CreateConnection | null> {
  const expected = normalizeExpected({ managerId, resourceId });
  const summaries: RPC.ConnectionItem[] = [];
  let offset = 0;
  let total = 0;
  let firstPage = true;

  while (firstPage || offset < total) {
    let response: unknown;
    try {
      response = await caller.getConnections(PAGE_LIMIT, offset, managerId, resourceId);
    } catch {
      throw new Error('PostgreSQL connection lookup failed');
    }
    const page = validatePage(response, offset);
    if (firstPage) {
      total = page.total;
      firstPage = false;
    } else if (page.total !== total) {
      throw invalidConnection();
    }
    for (const item of page.items) {
      if (!validateSummary(item, expected)) throw invalidConnection();
      summaries.push(item);
    }
    offset += page.items.length;
    if (page.items.length === 0 && total === 0) break;
  }

  if (summaries.length === 0) return null;
  if (summaries.length !== 1 || summaries.length !== total) throw invalidConnection();

  let full: unknown;
  try {
    full = await caller.getConnection(summaries[0].id);
  } catch {
    throw new Error('PostgreSQL connection lookup failed');
  }
  try {
    return normalizePostgresConnection(
      full,
      { ...expected, connectionId: summaries[0].id },
      platform,
    );
  } catch (error) {
    if (error instanceof PostgresRecoveryRequiredError) throw error;
    throw invalidConnection();
  }
}
