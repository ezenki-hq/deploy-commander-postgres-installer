import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import { describe, expect, it, vi } from 'vitest';
import { fakeCaller } from '../test/fakes';
import { linkPostgresConnection, unlinkPostgresConnection } from './groupConnection';

const resource: RPC.ResourceItem = {
  id: 'resource-1', manager: 'postgres-manager', agent: 'agent-1', type: 'postgres', name: 'postgres',
  external: false, created_at: 'now', updated_at: 'now',
};

function connectionFixture(initialLabels: Record<string, string> = {}) {
  const labels = {
    'postgres.access': 'database', 'postgres.database': 'orders', 'postgres.database-origin': 'existing', ...initialLabels,
  };
  const connection: RPC.ConnectionItem = {
    id: 'connection-1', manager: 'source-manager', resource: resource.id, external: false,
    created_at: 'now', updated_at: 'now', labels,
  };
  const caller = fakeCaller({
    getResource: vi.fn().mockResolvedValue({
      resource,
      config: {
        id: resource.id, manager: resource.manager, agent: 'agent-1', resource_type: 'postgres',
        name: 'postgres', metadata: { engine: 'postgres', version: '15', secret_keys: ['USERNAME', 'PASSWORD'] },
      },
    }),
    getConnections: vi.fn().mockImplementation(() =>
      Promise.resolve({ items: [{ ...connection, labels: { ...labels } }], limit: 50, offset: 0, total: 1 }),
    ),
    getConnection: vi.fn().mockImplementation(() => Promise.resolve({
      connection: { ...connection, labels: { ...labels } },
      config: {
        id: connection.id, manager: connection.manager, resource: connection.resource,
        metadata: { host: 'postgres', port: 5432, database: 'orders', access: { scope: 'database', operation: 'existing', database: 'orders' }, secret_keys: ['USERNAME', 'PASSWORD'] },
      },
    })),
    setConnectionLabel: vi.fn().mockImplementation(async (_id: string, key: string, value: string) => {
      labels[key] = value;
      return { key, value };
    }),
    removeConnectionLabel: vi.fn().mockImplementation(async (_id: string, key: string) => {
      delete labels[key];
    }),
  });
  return { caller, labels };
}

describe('linkPostgresConnection', () => {
  it('marks imported before adding group membership and preserves unrelated labels', async () => {
    const { caller } = connectionFixture({ team: 'analytics' });
    await expect(linkPostgresConnection(caller, 'postgres-manager', {
      action: 'link-connection', resourceId: 'resource-1', connectionId: 'connection-1',
      labels: { custom_deployer_group_id: 'group-a', custom_deployer_connection_origin: 'imported' },
    })).resolves.toMatchObject({ connection: { id: 'connection-1' } });
    expect(caller.setConnectionLabel).toHaveBeenNthCalledWith(1, 'connection-1', 'custom_deployer_connection_origin', 'imported');
    expect(caller.setConnectionLabel).toHaveBeenNthCalledWith(2, 'connection-1', 'custom_deployer_group_id', 'group-a');
    expect((await caller.getConnection('connection-1', { include_labels: true })).connection.labels).toMatchObject({ team: 'analytics', custom_deployer_group_id: 'group-a' });
  });

  it('rejects connections owned by another resource', async () => {
    const { caller } = connectionFixture();
    caller.getConnections = vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 });
    await expect(linkPostgresConnection(caller, 'postgres-manager', {
      action: 'link-connection', resourceId: 'resource-1', connectionId: 'foreign',
      labels: { custom_deployer_group_id: 'group-a', custom_deployer_connection_origin: 'imported' },
    })).rejects.toMatchObject({ status: 404 });
    expect(caller.setConnectionLabel).not.toHaveBeenCalled();
  });

  it.each([
    [{ custom_deployer_connection_origin: 'created' }],
    [{ custom_deployer_group_id: 'group-b', custom_deployer_connection_origin: 'imported' }],
  ])('rejects an already claimed connection %#', async (labels) => {
    const { caller } = connectionFixture(labels);
    await expect(linkPostgresConnection(caller, 'postgres-manager', {
      action: 'link-connection', resourceId: 'resource-1', connectionId: 'connection-1',
      labels: { custom_deployer_group_id: 'group-a', custom_deployer_connection_origin: 'imported' },
    })).rejects.toMatchObject({ status: 409 });
    expect(caller.setConnectionLabel).not.toHaveBeenCalled();
  });

  it('does not claim success when a label mutation fails', async () => {
    const { caller } = connectionFixture();
    caller.setConnectionLabel = vi.fn().mockRejectedValue(new Error('raw RPC failure'));
    await expect(linkPostgresConnection(caller, 'postgres-manager', {
      action: 'link-connection', resourceId: 'resource-1', connectionId: 'connection-1',
      labels: { custom_deployer_group_id: 'group-a', custom_deployer_connection_origin: 'imported' },
    })).rejects.toMatchObject({ status: 500 });
  });
});

describe('unlinkPostgresConnection', () => {
  it('removes group membership before imported origin and preserves other labels', async () => {
    const { caller } = connectionFixture({
      team: 'analytics', custom_deployer_group_id: 'group-a', custom_deployer_connection_origin: 'imported',
    });
    await expect(unlinkPostgresConnection(caller, 'postgres-manager', {
      action: 'unlink-connection', resourceId: 'resource-1', connectionId: 'connection-1', groupId: 'group-a',
    })).resolves.toMatchObject({ connection: { id: 'connection-1' } });
    expect(caller.removeConnectionLabel).toHaveBeenNthCalledWith(1, 'connection-1', 'custom_deployer_group_id');
    expect(caller.removeConnectionLabel).toHaveBeenNthCalledWith(2, 'connection-1', 'custom_deployer_connection_origin');
    expect((await caller.getConnection('connection-1', { include_labels: true })).connection.labels).toMatchObject({ team: 'analytics', 'postgres.access': 'database' });
  });

  it('rejects created connections and permits a completed retry', async () => {
    const created = connectionFixture({ custom_deployer_group_id: 'group-a', custom_deployer_connection_origin: 'created' });
    await expect(unlinkPostgresConnection(created.caller, 'postgres-manager', {
      action: 'unlink-connection', resourceId: 'resource-1', connectionId: 'connection-1', groupId: 'group-a',
    })).rejects.toMatchObject({ status: 409 });
    const completed = connectionFixture();
    await expect(unlinkPostgresConnection(completed.caller, 'postgres-manager', {
      action: 'unlink-connection', resourceId: 'resource-1', connectionId: 'connection-1', groupId: 'group-a',
    })).resolves.toMatchObject({ connection: { id: 'connection-1' } });
  });

  it('finishes a partial unlink on retry', async () => {
    const { caller, labels } = connectionFixture({
      custom_deployer_group_id: 'group-a', custom_deployer_connection_origin: 'imported',
    });
    const originalRemove = caller.removeConnectionLabel;
    caller.removeConnectionLabel = vi.fn(async (id: string, key: string) => {
      if (key === 'custom_deployer_connection_origin') throw new Error('temporary error');
      return originalRemove(id, key);
    });
    const request = {
      action: 'unlink-connection' as const, resourceId: 'resource-1', connectionId: 'connection-1', groupId: 'group-a',
    };
    await expect(unlinkPostgresConnection(caller, 'postgres-manager', request)).rejects.toMatchObject({ status: 500 });
    expect(labels.custom_deployer_group_id).toBeUndefined();
    caller.removeConnectionLabel = originalRemove;
    await expect(unlinkPostgresConnection(caller, 'postgres-manager', request)).resolves.toMatchObject({
      connection: { id: 'connection-1' },
    });
    expect(labels.custom_deployer_connection_origin).toBeUndefined();
  });
});
