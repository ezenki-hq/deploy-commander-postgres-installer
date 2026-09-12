import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import type { PlatformConnection } from './postgresContracts';
import {
  findExistingConnection,
  normalizePostgresConnection,
} from './postgresConnectionContract';
import { PostgresRecoveryRequiredError } from './postgresErrors';

const platform: PlatformConnection = {
  type: 'Platform',
  data: { network: 'current-postgres-network' },
};
const summary: RPC.ConnectionItem = {
  id: 'connection-1',
  manager: 'manager-2',
  resource: 'resource-1',
  external: false,
  created_at: 'now',
  updated_at: 'now',
};
const logicalMetadata = {
  host: 'postgres',
  port: 5432,
  database: 'db_0123456789abcdef0123456789abcdef',
  username: 'dc_user_0123456789abcdef0123456789abcdef',
  password: 'logical-password',
};

function full(metadata: Record<string, unknown>, id = summary.id) {
  return {
    connection: { ...summary, id },
    config: {
      id,
      manager: summary.manager,
      resource: summary.resource,
      metadata,
    },
  };
}

const expected = { managerId: 'manager-2', resourceId: 'resource-1' };

describe('normalizePostgresConnection', () => {
  it('enriches otherwise-valid legacy metadata without mutating the RPC result', () => {
    const received = full(logicalMetadata);
    const before = structuredClone(received);

    const normalized = normalizePostgresConnection(received, expected, platform);

    expect(normalized.config.metadata).toEqual({
      ...logicalMetadata,
      platform_connection: platform,
    });
    expect(received).toEqual(before);
    expect(normalized).not.toBe(received);
    expect(normalized.config).not.toBe(received.config);
    expect(normalized.config.metadata).not.toBe(received.config.metadata);
  });

  it('replaces a valid stale platform connection with the authoritative value', () => {
    const normalized = normalizePostgresConnection(full({
      ...logicalMetadata,
      platform_connection: {
        type: 'Platform',
        data: { network: 'stale-network' },
      },
    }), expected, platform);

    expect(normalized.config.metadata).toMatchObject({
      platform_connection: platform,
    });
  });

  it.each([
    ['host', { ...logicalMetadata, host: 'database' }],
    ['port', { ...logicalMetadata, port: 5433 }],
    ['database', { ...logicalMetadata, database: 'postgres' }],
    ['username', { ...logicalMetadata, username: 'postgres' }],
    ['reserved username', { ...logicalMetadata, username: 'pg_user_0123456789abcdef0123456789abcdef' }],
    ['password', { ...logicalMetadata, password: '' }],
    ['platform', {
      ...logicalMetadata,
      platform_connection: { type: 'Platform', data: { network: '' } },
    }],
  ])('rejects malformed %s metadata', (_field, metadata) => {
    expect(() => normalizePostgresConnection(full(metadata), expected, platform))
      .toThrow(PostgresRecoveryRequiredError);
  });

  it('rejects a full connection whose id differs from its configuration id', () => {
    const received = full(logicalMetadata);
    received.config.id = 'connection-other';
    expect(() => normalizePostgresConnection(received, expected, platform))
      .toThrow(PostgresRecoveryRequiredError);
  });

  it('rejects a looked-up result whose id differs from the summary id', () => {
    expect(() => normalizePostgresConnection(
      full(logicalMetadata, 'connection-other'),
      { ...expected, connectionId: summary.id },
      platform,
    )).toThrow(PostgresRecoveryRequiredError);
  });

  it.each([
    ['configuration manager', {
      ...full(logicalMetadata),
      config: { ...full(logicalMetadata).config, manager: 'manager-other' },
    }],
    ['configuration resource', {
      ...full(logicalMetadata),
      config: { ...full(logicalMetadata).config, resource: 'resource-other' },
    }],
    ['external connection', {
      ...full(logicalMetadata),
      connection: { ...full(logicalMetadata).connection, external: true },
    }],
  ])('rejects a mismatched %s', (_field, value) => {
    expect(() => normalizePostgresConnection(value, expected, platform))
      .toThrow(PostgresRecoveryRequiredError);
  });

  it.each([null, undefined])(
    'rejects a present invalid platform value %# instead of treating it as legacy',
    (platformConnection) => {
      expect(() => normalizePostgresConnection(full({
        ...logicalMetadata,
        platform_connection: platformConnection,
      }), expected, platform)).toThrow(PostgresRecoveryRequiredError);
    },
  );
});

describe('findExistingConnection', () => {
  it('returns one authorized connection enriched with the current platform', async () => {
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [summary], limit: 50, offset: 0, total: 1,
      }),
      getConnection: vi.fn().mockResolvedValue(full(logicalMetadata)),
    } as unknown as RPCCaller;

    await expect(findExistingConnection(
      caller, 'manager-2', 'resource-1', platform,
    )).resolves.toMatchObject({
      config: { metadata: { platform_connection: platform } },
    });
  });

  it('rejects multiple matching connections across pages', async () => {
    const second = { ...summary, id: 'connection-2' };
    const caller = {
      getConnections: vi.fn()
        .mockResolvedValueOnce({ items: [summary], limit: 1, offset: 0, total: 2 })
        .mockResolvedValueOnce({ items: [second], limit: 1, offset: 1, total: 2 }),
      getConnection: vi.fn().mockImplementation(async (id: string) =>
        full(logicalMetadata, id)),
    } as unknown as RPCCaller;

    await expect(findExistingConnection(
      caller, 'manager-2', 'resource-1', platform,
    )).rejects.toThrow(PostgresRecoveryRequiredError);
  });

  it.each([
    { items: [], limit: 50, offset: 0, total: 1 },
    { items: [summary], limit: 0, offset: 0, total: 1 },
    { items: [summary], limit: 50, offset: 1, total: 1 },
  ])('rejects inconsistent page data %#', async (page) => {
    const caller = {
      getConnections: vi.fn().mockResolvedValue(page),
    } as unknown as RPCCaller;
    await expect(findExistingConnection(
      caller, 'manager-2', 'resource-1', platform,
    )).rejects.toThrow(PostgresRecoveryRequiredError);
  });

  it('rejects a connection owned by another manager', async () => {
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [{ ...summary, manager: 'manager-other' }],
        limit: 50, offset: 0, total: 1,
      }),
    } as unknown as RPCCaller;
    await expect(findExistingConnection(
      caller, 'manager-2', 'resource-1', platform,
    )).rejects.toThrow(PostgresRecoveryRequiredError);
  });

  it('normalizes a connection lookup transport failure', async () => {
    const caller = {
      getConnections: vi.fn().mockRejectedValue(new Error('secret transport detail')),
    } as unknown as RPCCaller;
    await expect(findExistingConnection(
      caller, 'manager-2', 'resource-1', platform,
    )).rejects.toThrow('PostgreSQL connection lookup failed');
  });
});
