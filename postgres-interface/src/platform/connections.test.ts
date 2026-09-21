import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import { describe, expect, it, vi } from 'vitest';
import { fakeCaller } from '../test/fakes';
import { listResourceConnections, readPostgresConnection } from './connections';

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
      username: 'dc_user_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      password: 'connection-secret',
      access,
    },
  },
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
    const caller = fakeCaller({ getConnection: vi.fn().mockResolvedValue(details(connection)) });
    const result = await readPostgresConnection(caller, connection);
    expect(result).toMatchObject({
      managerId: 'consumer-1',
      resourceId: 'resource-1',
      authority: { access: 'database', database: 'orders', origin: 'managed' },
      access: { scope: 'database', operation: 'create', database: 'orders' },
      username: 'dc_user_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      password: 'connection-secret',
    });
    expect(result).not.toHaveProperty('platformConnection');
  });

  it('rejects malformed authority labels and preserves the database', async () => {
    const connection = item('connection-1', {
      labels: { 'postgres.access': 'full', 'postgres.database': 'orders' },
    });
    const caller = fakeCaller({ getConnection: vi.fn().mockResolvedValue(details(connection)) });
    await expect(readPostgresConnection(caller, connection)).rejects.toMatchObject({ status: 409 });
  });
});
