import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { PostgresRecoveryRequiredError } from './postgresErrors';
import { parsePlatformConnection, type PlatformConnection } from './postgresContracts';
import type { AccessRequest } from './postgresConnectionRequest';
import { sameLabels } from './postgresConnectionRequest';

/** The durable identity of a PostgreSQL connection request. */
export interface ConnectionIdentity {
  managerId: string;
  resourceId: string;
  access: AccessRequest;
  labels: Record<string, string>;
  connectionId?: string;
}

/** Optional access/label fields preserve compatibility with v1 run recovery. */
export interface ExpectedConnectionIdentity {
  managerId: string;
  resourceId: string;
  access?: AccessRequest;
  labels?: Record<string, string>;
  connectionId?: string;
}

export type ConnectionLookupResult =
  | { kind: 'none' }
  | { kind: 'match'; connection: RPC.CreateConnection }
  | { kind: 'conflict'; connectionId: string };

const PAGE_LIMIT = 50;
const USERNAME_PATTERN = /^dc_user_[0-9a-f]{32}$/;
const DATABASE_LIMIT = 63;
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

function validDatabase(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    value.toLowerCase() !== 'template0' &&
    value.toLowerCase() !== 'template1' &&
    new TextEncoder().encode(value).length <= DATABASE_LIMIT
  );
}

function validAccess(value: unknown): value is AccessRequest {
  if (!isRecord(value) || typeof value.scope !== 'string') return false;
  if (value.scope === 'database') {
    return (
      Object.keys(value).length === 3 &&
      (value.operation === 'create' || value.operation === 'existing') &&
      validDatabase(value.database)
    );
  }
  return (
    value.scope === 'full' &&
    Object.keys(value).length === 2 &&
    typeof value.superuser === 'boolean'
  );
}

function accessEqual(left: AccessRequest, right: AccessRequest): boolean {
  if (left.scope !== right.scope) return false;
  if (left.scope === 'database' && right.scope === 'database') {
    return left.operation === right.operation && left.database === right.database;
  }
  return left.scope === 'full' && right.scope === 'full' && left.superuser === right.superuser;
}

function parseLabels(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalidConnection();
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    if (key.trim().length === 0 || typeof label !== 'string') throw invalidConnection();
    labels[key] = label;
  }
  return labels;
}

function reservedLabels(access: AccessRequest): Record<string, string> {
  return access.scope === 'database'
    ? { 'postgres.access': 'database', 'postgres.database': access.database }
    : { 'postgres.access': 'full' };
}

function validateSummary(
  value: unknown,
  expected: Pick<ExpectedConnectionIdentity, 'managerId' | 'resourceId' | 'connectionId'>,
): value is RPC.ConnectionItem {
  return (
    isRecord(value) &&
    nonBlank(value.id) &&
    (!expected.connectionId || value.id === expected.connectionId) &&
    nonBlank(value.manager) &&
    value.manager === expected.managerId &&
    nonBlank(value.resource) &&
    value.resource === expected.resourceId &&
    value.external === false &&
    nonBlank(value.created_at) &&
    nonBlank(value.updated_at)
  );
}

function validatePage(
  value: unknown,
  expectedOffset: number,
): { items: RPC.ConnectionItem[]; limit: number; offset: number; total: number } {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(isRecord)) {
    throw invalidConnection();
  }
  if (
    typeof value.limit !== 'number' ||
    !Number.isSafeInteger(value.limit) ||
    value.limit <= 0 ||
    typeof value.offset !== 'number' ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    typeof value.total !== 'number' ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0
  ) {
    throw invalidConnection();
  }
  const total = value.total;
  const offset = value.offset;
  if (
    offset !== expectedOffset ||
    (value.items.length === 0 && total > 0) ||
    value.items.length > value.limit ||
    value.items.length > total ||
    offset > total ||
    offset + value.items.length > total ||
    (value.items.length < value.limit && offset + value.items.length < total)
  ) {
    throw invalidConnection();
  }
  return {
    items: value.items as unknown as RPC.ConnectionItem[],
    limit: value.limit,
    offset: value.offset,
    total,
  };
}

function normalizeExpected(expected: ExpectedConnectionIdentity): ExpectedConnectionIdentity {
  if (
    !nonBlank(expected.managerId) ||
    !nonBlank(expected.resourceId) ||
    (expected.connectionId !== undefined && !nonBlank(expected.connectionId)) ||
    (expected.access !== undefined && !validAccess(expected.access))
  ) {
    throw invalidConnection();
  }
  if (expected.labels !== undefined) parseLabels(expected.labels);
  return expected;
}

function normalizeConnection(
  value: unknown,
  expected: ExpectedConnectionIdentity,
  platform: PlatformConnection,
  options: { requireAccess?: boolean } = {},
): RPC.CreateConnection {
  const authoritativePlatform = parseAuthoritativePlatform(platform);
  const identity = normalizeExpected(expected);
  if (
    !isRecord(value) ||
    !isRecord(value.connection) ||
    !isRecord(value.config) ||
    !isRecord(value.config.metadata)
  ) {
    throw invalidConnection();
  }

  const connection = value.connection;
  const config = value.config;
  const metadata = config.metadata as UnknownRecord;
  if (
    !nonBlank(connection.id) ||
    !nonBlank(config.id) ||
    connection.id !== config.id ||
    (identity.connectionId !== undefined && connection.id !== identity.connectionId) ||
    !validateSummary(connection, identity) ||
    !nonBlank(config.manager) ||
    config.manager !== identity.managerId ||
    !nonBlank(config.resource) ||
    config.resource !== identity.resourceId
  ) {
    throw invalidConnection();
  }

  if (
    metadata.host !== 'postgres' ||
    metadata.port !== 5432 ||
    !validDatabase(metadata.database) ||
    typeof metadata.username !== 'string' ||
    !USERNAME_PATTERN.test(metadata.username) ||
    !nonBlank(metadata.password)
  ) {
    throw invalidConnection();
  }

  let metadataAccess: AccessRequest | undefined;
  if (Object.prototype.hasOwnProperty.call(metadata, 'access')) {
    if (!validAccess(metadata.access)) throw invalidConnection();
    metadataAccess = metadata.access;
  }
  if (options.requireAccess && !metadataAccess) throw invalidConnection();
  if (metadataAccess) {
    const expectedDatabase =
      metadataAccess.scope === 'database' ? metadataAccess.database : 'postgres';
    if (metadata.database !== expectedDatabase) throw invalidConnection();
  }
  if (identity.access !== undefined) {
    if (!metadataAccess || !accessEqual(metadataAccess, identity.access)) throw invalidConnection();
    const expectedDatabase =
      identity.access.scope === 'database' ? identity.access.database : 'postgres';
    if (metadata.database !== expectedDatabase) throw invalidConnection();
  }

  if (Object.prototype.hasOwnProperty.call(metadata, 'platform_connection')) {
    try {
      parsePlatformConnection(metadata.platform_connection);
    } catch {
      throw invalidConnection();
    }
  }

  if (identity.labels !== undefined) {
    const labels = parseLabels(connection.labels);
    if (!sameLabels(labels, identity.labels)) throw invalidConnection();
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

export function normalizePostgresConnection(
  value: unknown,
  expected: ExpectedConnectionIdentity,
  platform: PlatformConnection,
): RPC.CreateConnection {
  return normalizeConnection(value, expected, platform);
}

/** Find one exact identity while allowing unrelated connections on a resource. */
export async function findExistingConnection(
  caller: RPCCaller,
  identity: ConnectionIdentity,
  platform: PlatformConnection,
): Promise<ConnectionLookupResult>;
/** Compatibility overload for v1 recovery callers. */
export async function findExistingConnection(
  caller: RPCCaller,
  managerId: string,
  resourceId: string,
  platform: PlatformConnection,
): Promise<RPC.CreateConnection | null>;
export async function findExistingConnection(
  caller: RPCCaller,
  identityOrManager: ConnectionIdentity | string,
  resourceOrPlatform: string | PlatformConnection,
  maybePlatform?: PlatformConnection,
): Promise<ConnectionLookupResult | RPC.CreateConnection | null> {
  const legacy = typeof identityOrManager === 'string';
  const identity: ExpectedConnectionIdentity = legacy
    ? { managerId: identityOrManager, resourceId: resourceOrPlatform as string }
    : identityOrManager;
  const platform = (legacy ? maybePlatform : resourceOrPlatform) as PlatformConnection;
  const expected = normalizeExpected(identity);
  const access = identity.access;
  const labels = access ? reservedLabels(access) : undefined;
  const summaries: RPC.ConnectionItem[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total = 0;
  let firstPage = true;
  while (firstPage || offset < total) {
    let response: unknown;
    try {
      response = await caller.getConnections({
        manager: expected.managerId,
        resource: expected.resourceId,
        ...(labels ? { labels, label_match: 'all' as const } : {}),
        include_labels: true,
        limit: PAGE_LIMIT,
        offset,
      });
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
      if (!validateSummary(item, expected) || seen.has(item.id)) throw invalidConnection();
      parseLabels(item.labels);
      seen.add(item.id);
      summaries.push(item);
    }
    offset += page.items.length;
    if (page.items.length === 0 && total === 0) break;
  }

  if (legacy) {
    if (summaries.length === 0) return null;
    if (summaries.length !== 1 || summaries.length !== total) throw invalidConnection();
    let full: unknown;
    try {
      full = await caller.getConnection(summaries[0].id, { include_labels: true });
    } catch {
      throw new Error('PostgreSQL connection lookup failed');
    }
    return normalizeConnection(full, { ...expected, connectionId: summaries[0].id }, platform);
  }

  if (summaries.length === 0) return { kind: 'none' };
  let match: RPC.CreateConnection | undefined;
  let conflictId: string | undefined;
  let identityMatches = 0;
  for (const summary of summaries) {
    let full: unknown;
    try {
      full = await caller.getConnection(summary.id, { include_labels: true });
    } catch {
      throw new Error('PostgreSQL connection lookup failed');
    }
    // Validate every complete candidate before deciding if it is unrelated.
    const normalized = normalizeConnection(
      full,
      {
        managerId: expected.managerId,
        resourceId: expected.resourceId,
        connectionId: summary.id,
      },
      platform,
      { requireAccess: true },
    );
    const summaryLabels = parseLabels(summary.labels);
    const candidateLabels = parseLabels(normalized.connection.labels);
    if (!sameLabels(summaryLabels, candidateLabels)) throw invalidConnection();
    const metadata = normalized.config.metadata as UnknownRecord;
    if (!access || !validAccess(metadata.access) || !accessEqual(metadata.access, access)) {
      continue;
    }
    identityMatches += 1;
    if (sameLabels(candidateLabels, expected.labels ?? {})) {
      match = normalized;
    } else {
      conflictId = summary.id;
    }
  }

  if (identityMatches > 1) throw invalidConnection();
  if (match) return { kind: 'match', connection: match };
  if (conflictId) return { kind: 'conflict', connectionId: conflictId };
  return { kind: 'none' };
}
