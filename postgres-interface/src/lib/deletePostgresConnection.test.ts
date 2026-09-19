import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RPCCaller, RPC, StartRunOptions } from '@ezenki/deploy-commander-installer-interface';
import type { AccessRequest } from './postgresConnectionRequest';
import { createRunEventSource } from './runMonitor';
import { makeCleanupNote } from './connectionRuns';
import { buildCleanupPlan } from './postgresPlans';
import { deletePostgresConnection } from './deletePostgresConnection';
import { PostgresRecoveryRequiredError } from './postgresErrors';
import type { PlatformConnection } from './postgresContracts';

const platform: PlatformConnection = { type: 'Platform', data: { network: 'postgres-network' } };
const resource: RPC.ResourceItem = {
  id: 'resource-1',
  type: 'postgres',
  name: 'postgres',
  manager: 'postgres-manager',
  external: false,
  agent: 'agent-1',
  created_at: 'now',
  updated_at: 'now',
};
const administrator = {
  username: 'dc_admin_0123456789abcdef0123456789abcdef',
  password: 'admin-password',
};
const login = {
  username: 'dc_user_0123456789abcdef0123456789abcdef',
  password: 'logical-password',
};
const access: AccessRequest = { scope: 'database', operation: 'create', database: 'orders' };

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
function connectionFixture(requestedAccess: AccessRequest) {
  const database = requestedAccess.scope === 'database' ? requestedAccess.database : 'postgres';
  const labels =
    requestedAccess.scope === 'database'
      ? { 'postgres.access': 'database', 'postgres.database': database }
      : { 'postgres.access': 'full' };
  return {
    connection: {
      id: 'connection-1',
      manager: 'consumer-manager',
      resource: resource.id,
      external: false,
      created_at: 'now',
      updated_at: 'now',
      labels,
    },
    config: {
      id: 'connection-1',
      manager: 'consumer-manager',
      resource: resource.id,
      metadata: {
        host: 'postgres',
        port: 5432,
        database,
        username: login.username,
        password: login.password,
        access: requestedAccess,
        platform_connection: platform,
      },
    },
  };
}
function cleanupRun(
  id: string,
  status: 0 | 1 | 2 | 3 = 2,
  requestedAccess: AccessRequest = access,
): RPC.GetRun {
  return {
    run: {
      id,
      action: 'cleanup-connection',
      status,
      note: makeCleanupNote({
        operationId: '01234567-89ab-4def-8123-456789abcdef',
        callerId: 'consumer-manager',
        resourceId: resource.id,
      }),
      queued_at: 'now',
      created_at: 'now',
      updated_at: 'now',
    },
    config: {
      id,
      run: id,
      action: 'cleanup-connection',
      manager: 'postgres-manager',
      runner: 'ezenki/deploy-commander-runner:latest',
      metadata: buildCleanupPlan({
        administrator,
        login,
        access: requestedAccess,
        resourceId: resource.id,
        platform,
      }),
    },
  } as RPC.GetRun;
}
function callerFor(requestedAccess: AccessRequest = access) {
  const target = connectionFixture(requestedAccess);
  return {
    getMyResources: vi
      .fn()
      .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
    getResource: vi.fn().mockResolvedValue(resourceDetails()),
    getConnections: vi
      .fn()
      .mockResolvedValue({ items: [target.connection], limit: 50, offset: 0, total: 1 }),
    getConnection: vi.fn().mockResolvedValue(target),
    getRuns: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    start: vi.fn().mockResolvedValue({ id: 'cleanup-run', status: 0, queued_at: 'now' }),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
  } as unknown as RPCCaller & Record<string, ReturnType<typeof vi.fn>>;
}
const approval = vi.fn().mockResolvedValue({ allowed: true, connectionId: 'connection-1' });
function run(
  caller: RPCCaller,
  connectionId: string | null = 'connection-1',
  requestedAccess = access,
) {
  return deletePostgresConnection(
    {
      caller,
      events: createRunEventSource(),
      requestApproval: approval,
      waitForRun: vi.fn(async (_c, _e, id) => cleanupRun(id, 2, requestedAccess)),
      generateOperationId: () => '01234567-89ab-4def-8123-456789abcdef',
      signal: new AbortController().signal,
    },
    {
      currentManagerId: 'postgres-manager',
      callingManagerId: 'consumer-manager',
      metadata: { connectionId },
    },
  );
}

describe('deletePostgresConnection', () => {
  beforeEach(() => {
    approval.mockReset();
    approval.mockResolvedValue({ allowed: true, connectionId: 'connection-1' });
  });
  it('approves, cleans up, then deletes the owned record', async () => {
    const caller = callerFor();
    await expect(run(caller, null)).resolves.toEqual({ connection: 'connection-1' });
    expect(approval).toHaveBeenCalledWith({
      callingManagerId: 'consumer-manager',
      requestedConnectionId: null,
      choices: [{ id: 'connection-1', access }],
    });
    expect(caller.start).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cleanup-connection',
        runner: 'ezenki/deploy-commander-runner:latest',
      }),
    );
    expect(caller.deleteConnection).toHaveBeenCalledWith('connection-1');
    expect(
      (caller.deleteConnection as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      (caller.start as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
  });

  it.each([
    { scope: 'database', operation: 'create', database: 'orders' },
    { scope: 'database', operation: 'existing', database: 'warehouse' },
    { scope: 'full', superuser: false },
    { scope: 'full', superuser: true },
  ] as const)('passes exact access mode to cleanup plan %j', async (requestedAccess) => {
    const caller = callerFor(requestedAccess);
    await run(caller, 'connection-1', requestedAccess);
    const options = (caller.start as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as StartRunOptions;
    const service = (
      options.metadata as {
        services?: Record<string, { environment?: Record<string, string>; command?: string[] }>;
      }
    ).services?.['postgres-admin'];
    const expectedMode =
      requestedAccess.scope === 'database'
        ? `${requestedAccess.operation}-database`
        : `full-${requestedAccess.superuser ? 'superuser' : 'constrained'}`;
    expect(service?.environment?.ACCESS_MODE).toBe(expectedMode);
    expect(service?.command?.[2]).toMatch(
      requestedAccess.scope === 'database' && requestedAccess.operation === 'create'
        ? /DROP DATABASE/
        : /DROP ROLE/,
    );
    if (!(requestedAccess.scope === 'database' && requestedAccess.operation === 'create'))
      expect(service?.command?.[2]).not.toMatch(/DROP DATABASE/);
  });

  it('returns the same 404 for a missing supplied id', async () => {
    const caller = callerFor();
    (caller.getConnections as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      limit: 50,
      offset: 0,
      total: 0,
    });
    await expect(run(caller, 'connection-other')).rejects.toMatchObject({ status: 404 });
    expect(approval).not.toHaveBeenCalled();
    expect(caller.start).not.toHaveBeenCalled();
  });

  it('returns the same 404 for a supplied connection owned by another manager', async () => {
    const caller = callerFor();
    const other = {
      ...connectionFixture(access),
      connection: { ...connectionFixture(access).connection, manager: 'other-manager' },
    };
    (caller.getConnection as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(other);
    (caller.getConnections as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [other.connection],
      limit: 50,
      offset: 0,
      total: 1,
    });
    await expect(run(caller, 'connection-1')).rejects.toMatchObject({ status: 404 });
    expect(approval).not.toHaveBeenCalled();
  });

  it('cancels without starting cleanup or deleting the record', async () => {
    const caller = callerFor();
    approval.mockResolvedValueOnce({ allowed: false });
    await expect(run(caller, null)).rejects.toMatchObject({ status: 499 });
    expect(caller.start).not.toHaveBeenCalled();
    expect(caller.deleteConnection).not.toHaveBeenCalled();
  });

  it('fails closed for zero or multiple installations', async () => {
    const caller = callerFor();
    (caller.getMyResources as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      limit: 50,
      offset: 0,
      total: 0,
    });
    await expect(run(caller, null)).rejects.toThrow(PostgresRecoveryRequiredError);
  });

  it('rejects an approval id that was not offered', async () => {
    const caller = callerFor();
    approval.mockResolvedValueOnce({ allowed: true, connectionId: 'connection-forged' });
    await expect(run(caller, null)).rejects.toMatchObject({ status: 400 });
    expect(caller.start).not.toHaveBeenCalled();
  });

  it.each([
    [0, 'waits for queued cleanup'],
    [1, 'waits for running cleanup'],
    [2, 'reuses successful cleanup'],
    [3, 'surfaces failed cleanup'],
  ] as const)('%s: %s', async (status, label) => {
    void label;
    const caller = callerFor();
    const existing = cleanupRun('cleanup-existing', status);
    (caller.getRuns as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [existing.run],
      limit: 50,
      offset: 0,
      total: 1,
    });
    caller.getRun = vi.fn().mockResolvedValue(existing);
    if (status === 3) {
      await expect(run(caller)).rejects.toThrow('PostgreSQL connection cleanup failed');
      expect(caller.deleteConnection).not.toHaveBeenCalled();
    } else {
      await expect(run(caller)).resolves.toEqual({ connection: 'connection-1' });
      expect(caller.start).not.toHaveBeenCalled();
    }
  });

  it('requires recovery for duplicate exact cleanup runs', async () => {
    const caller = callerFor();
    const first = cleanupRun('cleanup-1', 2);
    const second = cleanupRun('cleanup-2', 2);
    (caller.getRuns as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [first.run, second.run],
      limit: 50,
      offset: 0,
      total: 2,
    });
    caller.getRun = vi
      .fn()
      .mockImplementation(async (id: string) => (id === 'cleanup-1' ? first : second));
    await expect(run(caller)).rejects.toThrow(PostgresRecoveryRequiredError);
  });

  it('reconciles a lost start response by immutable note', async () => {
    const caller = callerFor();
    (caller.start as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('lost response'),
    );
    (caller.getRuns as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
      .mockResolvedValueOnce({
        items: [cleanupRun('accepted-run', 1).run],
        limit: 50,
        offset: 0,
        total: 1,
      });
    await expect(run(caller)).resolves.toEqual({ connection: 'connection-1' });
  });
});
