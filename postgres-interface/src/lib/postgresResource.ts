import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import type { AdminCredentials } from './credentials';
import { parsePlatformConnection, type PlatformConnection } from './postgresContracts';
import { PostgresRecoveryRequiredError } from './postgresErrors';

export interface PostgresResourceMetadata {
  engine: 'postgres';
  version: '15';
  administrator: AdminCredentials;
}

export interface PostgresInstallation {
  resource: RPC.ResourceItem;
  credentials: AdminCredentials;
  platform: PlatformConnection;
}

const LIMIT = 50;
const ADMIN_USERNAME = /^dc_admin_[0-9a-f]{32}$/;
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recovery(): PostgresRecoveryRequiredError {
  return new PostgresRecoveryRequiredError();
}

function validResource(value: unknown): value is RPC.ResourceItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.trim() !== '' &&
    typeof value.type === 'string' &&
    value.type.trim() !== '' &&
    typeof value.name === 'string' &&
    value.name.trim() !== '' &&
    typeof value.manager === 'string' &&
    value.manager.trim() !== '' &&
    typeof value.external === 'boolean' &&
    typeof value.created_at === 'string' &&
    value.created_at.trim() !== '' &&
    typeof value.updated_at === 'string' &&
    value.updated_at.trim() !== ''
  );
}

function validPage(
  value: unknown,
  expectedOffset: number,
): value is { items: RPC.ResourceItem[]; limit: number; offset: number; total: number } {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(validResource) ||
    typeof value.limit !== 'number' ||
    !Number.isSafeInteger(value.limit) ||
    value.limit !== LIMIT ||
    typeof value.offset !== 'number' ||
    !Number.isSafeInteger(value.offset) ||
    typeof value.total !== 'number' ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0 ||
    value.offset !== expectedOffset ||
    value.offset < 0 ||
    value.items.length > value.limit ||
    value.items.length > value.total ||
    value.offset > value.total ||
    value.offset + value.items.length > value.total ||
    (value.items.length === 0 && value.total > 0) ||
    (value.items.length < value.limit && value.offset + value.items.length < value.total)
  )
    return false;
  return true;
}

export async function listPostgresResources(caller: RPCCaller): Promise<RPC.ResourceItem[]> {
  const matches: RPC.ResourceItem[] = [];
  let offset = 0;
  while (true) {
    let response: unknown;
    try {
      response = await caller.getMyResources('postgres', false, LIMIT, offset);
    } catch {
      throw recovery();
    }
    if (!validPage(response, offset)) throw recovery();
    matches.push(
      ...response.items.filter(
        (item) => !item.external && item.type === 'postgres' && item.name === 'postgres',
      ),
    );
    if (response.items.length === 0 || offset + response.items.length >= response.total)
      return matches;
    offset += LIMIT;
  }
}

function sameResource(actual: RPC.ResourceItem, expected: RPC.ResourceItem): boolean {
  return (
    actual.id === expected.id &&
    actual.manager === expected.manager &&
    actual.external === expected.external &&
    actual.type === expected.type &&
    actual.name === expected.name &&
    actual.created_at === expected.created_at &&
    actual.updated_at === expected.updated_at &&
    actual.agent === expected.agent
  );
}

function parseInstallation(details: unknown, resource: RPC.ResourceItem): PostgresInstallation {
  if (
    !isRecord(details) ||
    !validResource(details.resource) ||
    !sameResource(details.resource, resource) ||
    !isRecord(details.config)
  )
    throw recovery();
  const config = details.config;
  if (
    config.id !== resource.id ||
    config.manager !== resource.manager ||
    typeof config.agent !== 'string' ||
    config.agent.trim() === '' ||
    config.resource_type !== 'postgres' ||
    config.name !== 'postgres' ||
    !isRecord(config.metadata) ||
    config.metadata.engine !== 'postgres' ||
    config.metadata.version !== '15' ||
    !isRecord(config.metadata.administrator)
  )
    throw recovery();
  const administrator = config.metadata.administrator;
  if (
    Object.keys(administrator).length !== 2 ||
    typeof administrator.username !== 'string' ||
    !ADMIN_USERNAME.test(administrator.username) ||
    typeof administrator.password !== 'string' ||
    administrator.password.trim() === ''
  )
    throw recovery();
  if (!Object.prototype.hasOwnProperty.call(config, 'platform_connection')) throw recovery();
  let platform: PlatformConnection;
  try {
    platform = parsePlatformConnection(config.platform_connection);
  } catch {
    throw recovery();
  }
  return {
    resource,
    credentials: { username: administrator.username, password: administrator.password },
    platform,
  };
}

export async function readPostgresInstallation(
  caller: RPCCaller,
  resource: RPC.ResourceItem,
): Promise<PostgresInstallation> {
  if (
    !validResource(resource) ||
    resource.external ||
    resource.type !== 'postgres' ||
    resource.name !== 'postgres'
  )
    throw recovery();
  let details: unknown;
  try {
    details = await caller.getResource(resource.id);
  } catch {
    throw recovery();
  }
  return parseInstallation(details, resource);
}
