import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import { describe, expect, it, vi } from 'vitest';
import type { InstallationProjection } from './resources';
import { loadDashboardProjection } from './dashboardProjection';
import { fakeCaller } from '../test/fakes';

const resource: RPC.ResourceItem = {
  id: 'resource-1',
  manager: 'postgres-manager',
  agent: 'agent-1',
  type: 'postgres',
  name: 'postgres',
  external: false,
  created_at: '2026-09-20T00:00:00Z',
  updated_at: '2026-09-20T00:00:00Z',
};

const connection = (id: string): RPC.ConnectionItem => ({
  id,
  manager: 'consumer-1',
  resource: resource.id,
  external: false,
  labels: {
    'postgres.access': 'database',
    'postgres.database': 'orders',
    'postgres.database-origin': 'managed',
  },
  created_at: '2026-09-20T00:00:00Z',
  updated_at: '2026-09-20T00:00:00Z',
});

const installedProjection: InstallationProjection = { kind: 'installed', resource };

function dashboardCaller(items: RPC.ConnectionItem[]) {
  return fakeCaller({
    getMyResources: vi.fn().mockResolvedValue({
      items: [resource],
      limit: 50,
      offset: 0,
      total: 1,
    }),
    getConnections: vi.fn().mockResolvedValue({
      items,
      limit: 50,
      offset: 0,
      total: items.length,
    }),
  });
}

describe('loadDashboardProjection', () => {
  it('returns installed state and connection count from current resources and connections', async () => {
    const caller = dashboardCaller([connection('connection-1'), connection('connection-2')]);
    await expect(loadDashboardProjection(caller)).resolves.toEqual({
      installation: installedProjection,
      connectionCount: 2,
    });
  });

  it('uses a lifecycle projection without re-reading installation state', async () => {
    const caller = dashboardCaller([connection('connection-1')]);
    await expect(loadDashboardProjection(caller, installedProjection)).resolves.toEqual({
      installation: installedProjection,
      connectionCount: 1,
    });
    expect(caller.getMyResources).not.toHaveBeenCalled();
  });

  it('returns zero connections when PostgreSQL is not installed', async () => {
    const caller = dashboardCaller([]);
    const notInstalled: InstallationProjection = { kind: 'not-installed' };
    await expect(loadDashboardProjection(caller, notInstalled)).resolves.toEqual({
      installation: notInstalled,
      connectionCount: 0,
    });
    expect(caller.getConnections).not.toHaveBeenCalled();
  });
});
