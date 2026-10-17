import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import { describe, expect, it, vi } from 'vitest';
import { fakeCaller } from '../test/fakes';
import {
  findCompatibleConnection,
  listResourceConnections,
  readPostgresConnection,
  type PostgresConnection,
} from './connections';

const item = (id: string, overrides: Partial<RPC.ConnectionItem> = {}): RPC.ConnectionItem => ({
  id,
  manager: 'consumer-1',
  resource: 'resource-1',
  external: false,
  created_at: '2026-09-20T00:00:00Z',
  updated_at: '2026-09-20T00:00:00Z',
  labels: {
    'postgres.access': 'database',
    'postgres.database': 'orders',
    'postgres.database-origin': 'managed',
  },
  ...overrides,
});

const details = (
  connection: RPC.ConnectionItem,
  access = { scope: 'database', operation: 'create', database: 'orders' },
) => ({
  connection,
  config: {
    id: connection.id,
    manager: connection.manager,
    resource: connection.resource,
    metadata: {
      host: 'postgres',
      port: 5432,
      database: access.scope === 'database' ? access.database : 'postgres',
      secret_keys: ['USERNAME', 'PASSWORD'],
      access,
    },
  },
});

const compatibleCandidate = (labels: Record<string, string>): PostgresConnection => ({
  item: item('connection-1', { labels }),
  managerId: 'consumer-1',
  resourceId: 'resource-1',
  authority: { access: 'database', database: 'orders', origin: 'managed' },
  access: { scope: 'database', operation: 'create', database: 'orders' },
  metadata: {
    access: { scope: 'database', operation: 'create', database: 'orders' },
    secret_keys: ['USERNAME', 'PASSWORD'],
  },
});

describe('findCompatibleConnection', () => {
  it('accepts additional persisted labels when no caller labels were requested', () => {
    const connection = compatibleCandidate({
      'postgres.access': 'database',
      'postgres.database': 'orders',
      'postgres.database-origin': 'managed',
      'platform.connection-id': 'connection-1',
    });

    expect(
      findCompatibleConnection([connection], {
        managerId: 'consumer-1',
        resourceId: 'resource-1',
        access: { scope: 'database', operation: 'create', database: 'orders' },
        labels: {},
        groupId: undefined,
      }),
    ).toEqual({ kind: 'match', connection });
  });

  it('rejects a connection when a requested caller label has a different value', () => {
    const connection = compatibleCandidate({
      'postgres.access': 'database',
      'postgres.database': 'orders',
      'postgres.database-origin': 'managed',
      team: 'engineering',
    });

    expect(
      findCompatibleConnection([connection], {
        managerId: 'consumer-1',
        resourceId: 'resource-1',
        access: { scope: 'database', operation: 'create', database: 'orders' },
        labels: { team: 'payments' },
        groupId: undefined,
      }),
    ).toEqual({ kind: 'none' });
  });

  it('does not reuse a connection from another group with the same access', () => {
    const connection = compatibleCandidate({
      'postgres.access': 'database',
      'postgres.database': 'orders',
      'postgres.database-origin': 'managed',
      custom_deployer_group_id: 'group-b',
    });
    expect(
      findCompatibleConnection([connection], {
        managerId: 'consumer-1',
        resourceId: 'resource-1',
        access: { scope: 'database', operation: 'create', database: 'orders' },
        labels: {},
        groupId: 'group-a',
      }),
    ).toEqual({ kind: 'none' });
  });
});

describe('listResourceConnections', () => {
  it('loads every connection page before calculating database peers', async () => {
    const firstFifty = Array.from({ length: 50 }, (_, index) => item(`connection-${index}`));
    const finalPeer = item('connection-50');
    const caller = fakeCaller({
      getConnections: vi
        .fn()
        .mockResolvedValueOnce({ items: firstFifty, limit: 50, offset: 0, total: 51 })
        .mockResolvedValueOnce({ items: [finalPeer], limit: 50, offset: 50, total: 51 }),
      getConnection: vi.fn((id: string) =>
        Promise.resolve(details(id === finalPeer.id ? finalPeer : item(id))),
      ),
      getSecretKeys: vi.fn().mockResolvedValue(['USERNAME', 'PASSWORD']),
    });
    const connections = await listResourceConnections(caller, 'resource-1');
    expect(connections).toHaveLength(51);
    expect(caller.getConnections).toHaveBeenNthCalledWith(2, {
      limit: 50,
      offset: 50,
      resource: 'resource-1',
      include_labels: true,
    });
  });
});

describe('readPostgresConnection', () => {
  it('parses database connection authority and metadata', async () => {
    const connection = item('connection-1');
    const caller = fakeCaller({
      getConnection: vi.fn().mockResolvedValue(details(connection)),
      getSecretKeys: vi.fn().mockResolvedValue(['USERNAME', 'PASSWORD']),
    });
    const result = await readPostgresConnection(caller, connection);
    expect(result).toMatchObject({
      managerId: 'consumer-1',
      resourceId: 'resource-1',
      authority: { access: 'database', database: 'orders', origin: 'managed' },
      access: { scope: 'database', operation: 'create', database: 'orders' },
      metadata: { secret_keys: ['USERNAME', 'PASSWORD'] },
    });
    expect(result).not.toHaveProperty('username');
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('platformConnection');
  });

  it('rejects malformed authority labels and preserves the database', async () => {
    const connection = item('connection-1', {
      labels: { 'postgres.access': 'full', 'postgres.database': 'orders' },
    });
    const caller = fakeCaller({ getConnection: vi.fn().mockResolvedValue(details(connection)) });
    await expect(readPostgresConnection(caller, connection)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects credential values in public connection metadata', async () => {
    const connection = item('connection-1');
    const caller = fakeCaller({
      getConnection: vi.fn().mockResolvedValue({
        ...details(connection),
        config: {
          ...details(connection).config,
          metadata: {
            ...details(connection).config.metadata,
            username: 'sensitive',
          },
        },
      }),
    });
    await expect(readPostgresConnection(caller, connection)).rejects.toMatchObject({ status: 409 });
  });
});
