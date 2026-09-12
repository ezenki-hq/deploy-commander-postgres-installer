import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { PostgresRecoveryRequiredError } from './postgresErrors';
import { listPostgresResources, readPostgresInstallation } from './postgresResource';

const resource: RPC.ResourceItem = {
  id: 'resource-1', type: 'postgres', name: 'postgres', external: false,
  manager: 'postgres-manager', created_at: 'now', updated_at: 'now',
};
const details = {
  resource,
  config: {
    id: 'resource-1', manager: 'postgres-manager', agent: 'agent-1',
    name: 'postgres', resource_type: 'postgres',
    metadata: {
      engine: 'postgres', version: '15',
      administrator: {
        username: 'pg_admin_0123456789abcdef0123456789abcdef',
        password: 'admin-password',
      },
    },
    platform_connection: {
      type: 'Platform', data: { network: 'postgres-network' },
    },
  },
};
const caller = (value: Partial<RPCCaller>) => value as RPCCaller;

describe('postgres resource contract', () => {
  it('lists every exact non-external postgres resource with exhaustive paging', async () => {
    const match2 = { ...resource, id: 'resource-2' };
    const getMyResources = vi.fn()
      .mockResolvedValueOnce({ items: [
        { ...resource, external: true },
        { ...resource, type: 'database' },
        resource,
        ...Array.from({ length: 47 }, (_, i) => ({ ...resource, id: `other-${i}`, type: 'database' })),
      ], limit: 50, offset: 0, total: 51 })
      .mockResolvedValueOnce({ items: [match2], limit: 50, offset: 50, total: 51 });

    await expect(listPostgresResources(caller({ getMyResources }))).resolves.toEqual([resource, match2]);
    expect(getMyResources).toHaveBeenNthCalledWith(1, 'postgres', false, 50, 0);
    expect(getMyResources).toHaveBeenNthCalledWith(2, 'postgres', false, 50, 50);
  });

  it('rejects malformed pagination', async () => {
    const getMyResources = vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 10, total: 0 });
    await expect(listPostgresResources(caller({ getMyResources }))).rejects.toBeInstanceOf(PostgresRecoveryRequiredError);
  });

  it('reads and strictly validates owner-scoped installation details', async () => {
    const getResource = vi.fn().mockResolvedValue(details);
    await expect(readPostgresInstallation(caller({ getResource }), resource)).resolves.toEqual({
      resource,
      credentials: details.config.metadata.administrator,
      platform: details.config.platform_connection,
    });
    expect(getResource).toHaveBeenCalledWith('resource-1');
  });

  it.each([
    ['owner', { resource: { ...resource, manager: 'other-manager' } }],
    ['identity', { config: { ...details.config, id: 'other' } }],
    ['administrator', { config: { ...details.config, metadata: { ...details.config.metadata, administrator: { username: 'bad', password: '' } } } }],
    ['metadata', { config: { ...details.config, metadata: { engine: 'postgres', version: '15' } } }],
    ['platform', { config: { ...details.config, platform_connection: { type: 'Platform', data: { network: '' } } } }],
  ])('rejects malformed %s details', async (_label, change) => {
    await expect(readPostgresInstallation(caller({ getResource: vi.fn().mockResolvedValue({ ...details, ...change }) }), resource))
      .rejects.toBeInstanceOf(PostgresRecoveryRequiredError);
  });
});
