import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { createPostgresConnection, type ConnectionWorkflowDeps } from './createPostgresConnection';
import type { PlatformConnection } from './postgresContracts';

const platform: PlatformConnection = { type: 'Platform', data: { network: 'postgres-network' } };
const resource: RPC.ResourceItem = {
  id: 'resource-1',
  type: 'postgres',
  name: 'postgres',
  manager: 'provider-manager',
  external: false,
  agent: 'agent-1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};
const administrator = { username: 'dc_admin_0123456789abcdef0123456789abcdef', password: 'admin' };
const login = { username: 'dc_user_0123456789abcdef0123456789abcdef', password: 'secret' };

function resourceDetails() {
  return {
    resource,
    config: {
      id: resource.id,
      manager: resource.manager,
      agent: resource.agent,
      resource_type: 'postgres',
      name: 'postgres',
      metadata: { engine: 'postgres', version: '15', administrator },
      platform_connection: platform,
    },
  };
}

function connection() {
  return {
    connection: {
      id: 'connection-1',
      manager: 'consumer-manager',
      resource: resource.id,
      external: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      labels: {
        team: 'payments',
        'postgres.access': 'database',
        'postgres.database': 'orders',
      },
    },
    config: {
      id: 'connection-1',
      manager: 'consumer-manager',
      resource: resource.id,
      metadata: {
        host: 'postgres',
        port: 5432,
        database: 'orders',
        username: login.username,
        password: login.password,
        platform_connection: platform,
        access: { scope: 'database', operation: 'create', database: 'orders' },
      },
    },
  };
}

function deps(caller: RPCCaller, requestApproval: ConnectionWorkflowDeps['requestApproval']) {
  return {
    caller,
    events: { subscribe: vi.fn(() => vi.fn()), publish: vi.fn() },
    requestApproval,
    generateCredentials: () => login,
    waitForRun: vi.fn().mockResolvedValue({ run: { id: 'run-1', status: 2 } }),
    signal: new AbortController().signal,
  } as unknown as ConnectionWorkflowDeps;
}

describe('createPostgresConnection', () => {
  it('requests approval and persists the connection through the runner', async () => {
    const caller = {
      getMyResources: vi
        .fn()
        .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      getResource: vi.fn().mockResolvedValue(resourceDetails()),
      getRuns: vi.fn().mockResolvedValue({ items: [], limit: 1, offset: 0, total: 0 }),
      databaseQuery: vi
        .fn()
        .mockResolvedValue({ results: [{ status: 'OK', result: [{ name: 'analytics' }] }] }),
      getConnections: vi
        .fn()
        .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
        .mockResolvedValueOnce({
          items: [connection().connection],
          limit: 50,
          offset: 0,
          total: 1,
        }),
      getConnection: vi.fn().mockResolvedValue(connection()),
      start: vi.fn().mockResolvedValue({ id: 'run-1', status: 0, queued_at: 'now' }),
    } as unknown as RPCCaller;
    const requestApproval = vi.fn().mockResolvedValue({
      allowed: true,
      access: { scope: 'database', operation: 'create', database: 'orders' },
    });

    const result = await createPostgresConnection(deps(caller, requestApproval), {
      currentManagerId: 'provider-manager',
      callingManagerId: 'consumer-manager',
      metadata: {
        access: { scope: 'database', operation: 'create', database: 'orders' },
        labels: { team: 'payments' },
      },
    });

    expect(requestApproval).toHaveBeenCalledWith({
      callingManagerId: 'consumer-manager',
      installsPostgres: false,
      requestedAccess: { scope: 'database', operation: 'create', database: 'orders' },
      callerLabels: { team: 'payments' },
      catalogDatabases: ['analytics'],
    });
    expect(caller.start).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create-connection',
        runner: 'ezenki/deploy-commander-runner:latest',
        metadata: expect.objectContaining({ connections: expect.any(Object) }),
      }),
    );
    expect(caller.createConnection).toBeUndefined();
    expect(result).toEqual(
      expect.objectContaining({ connection: expect.objectContaining({ id: 'connection-1' }) }),
    );
  });

  it('requires a fresh decision and rejects cancellation without starting a run', async () => {
    const caller = {
      getMyResources: vi
        .fn()
        .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      getResource: vi.fn().mockResolvedValue(resourceDetails()),
      getRuns: vi.fn().mockResolvedValue({ items: [], limit: 1, offset: 0, total: 0 }),
      databaseQuery: vi.fn().mockResolvedValue({ results: [{ status: 'OK', result: [] }] }),
      start: vi.fn(),
    } as unknown as RPCCaller;
    const requestApproval = vi.fn().mockResolvedValue({ allowed: false });
    await expect(
      createPostgresConnection(deps(caller, requestApproval), {
        currentManagerId: 'provider-manager',
        callingManagerId: 'consumer-manager',
        metadata: { access: null, labels: { team: 'payments' } },
      }),
    ).rejects.toMatchObject({ status: 499 });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(caller.start).not.toHaveBeenCalled();
  });
});
