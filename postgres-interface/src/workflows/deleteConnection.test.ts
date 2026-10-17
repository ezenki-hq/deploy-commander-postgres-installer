import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import { describe, expect, it, vi } from 'vitest';
import type { AccessRequest } from '../domain/requests';
import type { PostgresConnection } from '../platform/connections';
import { deferred } from '../test/fakes';
import type {
  DeleteApprovalContext,
  DeleteApprovalDecision,
  DeleteConnectionDeps,
} from './deleteConnection';
import { deletePostgresConnection } from './deleteConnection';

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
const explicitRequest = {
  currentManagerId: 'postgres-manager',
  callingManagerId: 'consumer-1',
  metadata: { action: 'delete-connection' as const, connectionId: 'target' },
};
const selectionRequest = {
  ...explicitRequest,
  metadata: { action: 'delete-connection' as const, connectionId: null },
};
const access: AccessRequest = { scope: 'database', operation: 'create', database: 'orders' };
const labels = {
  team: 'payments',
  'postgres.access': 'database',
  'postgres.database': 'orders',
  'postgres.database-origin': 'managed',
};
const item = (
  id: string,
  manager = 'consumer-1',
  connectionLabels: Record<string, string> = labels,
): RPC.ConnectionItem => ({
  id,
  manager,
  resource: resource.id,
  external: false,
  created_at: '2026-09-20T00:00:00Z',
  updated_at: '2026-09-20T00:00:00Z',
  labels: connectionLabels,
});
const target = (
  id = 'target',
  manager = 'consumer-1',
  targetAccess: AccessRequest = access,
  connectionLabels: Record<string, string> = labels,
): PostgresConnection => ({
  item: item(id, manager, connectionLabels),
  managerId: manager,
  resourceId: resource.id,
  authority:
    targetAccess.scope === 'database'
      ? { access: 'database', database: targetAccess.database, origin: 'managed' }
      : { access: 'full' },
  access: targetAccess,
  metadata: {
    access: targetAccess,
    secret_keys: ['USERNAME', 'PASSWORD'],
  },
});
const details = (connection: PostgresConnection): RPC.GetConnection => ({
  connection: connection.item,
  config: {
    id: connection.item.id,
    manager: connection.managerId,
    resource: connection.resourceId,
    metadata: connection.metadata,
  },
});

function createDeps(
  connections: PostgresConnection[] = [target()],
  overrides: Partial<DeleteConnectionDeps> = {},
) {
  const approval = vi.fn(
    async (context: DeleteApprovalContext): Promise<DeleteApprovalDecision> => ({
      allowed: true,
      connectionId: context.requestedConnectionId ?? connections[0]?.item.id ?? 'target',
    }),
  );
  let detailCalls = 0;
  const caller = {
    getMyResources: vi
      .fn()
      .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
    getResource: vi.fn().mockResolvedValue({
      resource,
      config: {
        id: resource.id,
        manager: resource.manager,
        agent: 'agent-1',
        resource_type: 'postgres',
        name: 'postgres',
        metadata: {
          engine: 'postgres',
          version: '15',
          secret_keys: ['USERNAME', 'PASSWORD'],
        },
      },
    }),
    getConnections: vi.fn().mockResolvedValue({
      items: connections.map((c) => c.item),
      limit: 50,
      offset: 0,
      total: connections.length,
    }),
    getConnection: vi.fn((id: string) => {
      detailCalls += 1;
      const found = connections.find((c) => c.item.id === id);
      return detailCalls > connections.length * 2
        ? Promise.reject(new Error('404'))
        : found
          ? Promise.resolve(details(found))
          : Promise.reject(new Error('404'));
    }),
    getSecretKeys: vi.fn().mockResolvedValue([
      { key: 'USERNAME', created_at: 'now', updated_at: 'now' },
      { key: 'PASSWORD', created_at: 'now', updated_at: 'now' },
    ]),
    start: vi.fn(),
    deleteConnection: vi.fn(),
  } as unknown as DeleteConnectionDeps['caller'];
  const deps: DeleteConnectionDeps = {
    caller,
    requestApproval: approval,
    runTracker: {
      startAndWait: vi.fn().mockResolvedValue({ run: { status: 2 }, config: {} }),
      dispose: vi.fn(),
    },
    databaseOwnerRole: vi.fn(async () => `dc_db_${'d'.repeat(32)}`),
    signal: new AbortController().signal,
    ...overrides,
  };
  return { deps, caller, approval: deps.requestApproval as typeof approval };
}

describe('deletePostgresConnection', () => {
  it('does not start cleanup or delete a record before confirmation', async () => {
    const gate = deferred<DeleteApprovalDecision>();
    const { deps, caller, approval } = createDeps([target()], {
      requestApproval: vi.fn(() => gate.promise),
    });
    const pending = deletePostgresConnection(deps, explicitRequest);
    await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
    expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
    expect(caller.deleteConnection).not.toHaveBeenCalled();
    gate.resolve({ allowed: false });
    await expect(pending).rejects.toMatchObject({ status: 499 });
  });

  it('shows only connections owned by the trusted caller', async () => {
    const gate = deferred<DeleteApprovalDecision>();
    const callerTarget = target('caller');
    const other = target('other', 'other-manager');
    const { deps, approval } = createDeps([callerTarget, other], {
      requestApproval: vi.fn(() => gate.promise),
    });
    const pending = deletePostgresConnection(deps, selectionRequest);
    await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({ choices: [expect.objectContaining({ id: 'caller' })] }),
    );
    gate.resolve({ allowed: false });
    await expect(pending).rejects.toMatchObject({ status: 499 });
  });

  it('preflights every requested ID before starting any deletion', async () => {
    const { deps, approval } = createDeps([target('connection-1')]);
    await expect(
      deletePostgresConnection(deps, {
        ...explicitRequest,
        metadata: { action: 'delete-connection', connectionIds: ['connection-1', 'missing'] },
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(approval).not.toHaveBeenCalled();
    expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
  });

  it('rejects imported and foreign-resource targets before approval', async () => {
    const imported = target('imported', 'other-manager', access, {
      ...labels,
      custom_deployer_connection_origin: 'imported',
      custom_deployer_group_id: 'group-a',
    });
    const importedDeps = createDeps([imported]);
    await expect(
      deletePostgresConnection(importedDeps.deps, {
        ...explicitRequest,
        metadata: { action: 'delete-connection', connectionIds: ['imported'] },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(importedDeps.approval).not.toHaveBeenCalled();
    expect(importedDeps.deps.runTracker.startAndWait).not.toHaveBeenCalled();

    const foreign = target('foreign');
    foreign.item.resource = 'resource-foreign';
    foreign.resourceId = 'resource-foreign';
    const foreignDeps = createDeps([foreign]);
    await expect(
      deletePostgresConnection(foreignDeps.deps, {
        ...explicitRequest,
        metadata: { action: 'delete-connection', connectionIds: ['foreign'] },
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(foreignDeps.approval).not.toHaveBeenCalled();
    expect(foreignDeps.deps.runTracker.startAndWait).not.toHaveBeenCalled();
  });

  it('rejects deleting an imported connection by a single explicit ID', async () => {
    const imported = target('imported', 'consumer-1', access, {
      ...labels,
      custom_deployer_connection_origin: 'imported',
      custom_deployer_group_id: 'group-a',
    });
    const { deps, approval } = createDeps([imported]);
    await expect(
      deletePostgresConnection(deps, {
        ...explicitRequest,
        metadata: { action: 'delete-connection', connectionId: 'imported' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(approval).not.toHaveBeenCalled();
    expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
  });

  it('approves every requested connection and starts one runner for the batch', async () => {
    const first = target('connection-1', 'another-manager');
    const second = target('connection-2');
    let active = [first, second];
    const { deps, caller, approval } = createDeps(active);
    caller.getConnections = vi.fn(async ({ limit, offset }) => {
      const items = active.slice(offset, offset + limit).map((connection) => connection.item);
      return { items, limit, offset, total: active.length };
    });
    caller.getConnection = vi.fn(async (id: string) => {
      const connection = active.find((candidate) => candidate.item.id === id);
      if (!connection) throw new Error('404');
      return details(connection);
    });
    const completedRun = {
      config: {
        action: 'delete-connection',
        manager: 'postgres-manager',
        metadata: {},
        run: 'run-1',
        runner: 'runner',
      },
      run: { id: 'run-1', status: 2 },
    } as unknown as RPC.GetRun;
    vi.spyOn(deps.runTracker, 'startAndWait').mockImplementation(async (options) => {
      const metadata = options.metadata as { connections?: { remove?: { id: string }[] } };
      const removedIds = new Set(metadata.connections?.remove?.map(({ id }) => id));
      active = active.filter((connection) => !removedIds.has(connection.item.id));
      return completedRun;
    });
    const selected = ['connection-1', 'connection-2'];
    const result = await deletePostgresConnection(deps, {
      ...explicitRequest,
      metadata: { action: 'delete-connection', connectionIds: selected },
    });
    expect(result).toEqual({ connections: selected });
    expect(approval).toHaveBeenCalledTimes(2);
    expect(approval).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        requestedConnectionId: 'connection-1',
        choices: [expect.objectContaining({ id: 'connection-1', effect: 'role-only' })],
      }),
    );
    expect(approval).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        requestedConnectionId: 'connection-2',
        choices: [expect.objectContaining({ id: 'connection-2', effect: 'role-and-database' })],
      }),
    );
    expect(deps.runTracker.startAndWait).toHaveBeenCalledOnce();
    expect(deps.runTracker.startAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          connections: {
            remove: [
              expect.objectContaining({ id: 'connection-1' }),
              expect.objectContaining({ id: 'connection-2' }),
            ],
          },
        }),
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(active).toEqual([]);
  });

  it('starts no run until all approvals and preserves records if the run fails', async () => {
    const first = target('connection-1');
    const second = target('connection-2');
    const third = target('connection-3');
    const active = [first, second, third];
    const { deps, caller, approval } = createDeps(active);
    caller.getConnections = vi.fn(async ({ limit, offset }) => {
      const items = active.slice(offset, offset + limit).map((connection) => connection.item);
      return { items, limit, offset, total: active.length };
    });
    caller.getConnection = vi.fn(async (id: string) => {
      const connection = active.find((candidate) => candidate.item.id === id);
      if (!connection) throw new Error('404');
      return details(connection);
    });
    vi.spyOn(deps.runTracker, 'startAndWait').mockImplementation(async (options) => {
      const remove = (options.metadata as { connections?: { remove?: { id: string }[] } })
        .connections?.remove;
      expect(remove).toHaveLength(3);
      throw new Error('runner failed');
    });
    await expect(
      deletePostgresConnection(deps, {
        ...explicitRequest,
        metadata: {
          action: 'delete-connection',
          connectionIds: ['connection-1', 'connection-2', 'connection-3'],
        },
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(approval).toHaveBeenCalledTimes(3);
    expect(deps.runTracker.startAndWait).toHaveBeenCalledOnce();
    expect(active.map((connection) => connection.item.id)).toEqual([
      'connection-1',
      'connection-2',
      'connection-3',
    ]);
  });

  it.each([
    [target('managed'), [], 'role-and-database'],
    [
      target(
        'existing',
        'consumer-1',
        { scope: 'database', operation: 'existing', database: 'warehouse' },
        {
          'postgres.access': 'database',
          'postgres.database': 'warehouse',
          'postgres.database-origin': 'existing',
        },
      ),
      [],
      'role-only',
    ],
    [
      target(
        'full',
        'consumer-1',
        { scope: 'full', superuser: false },
        { 'postgres.access': 'full' },
      ),
      [],
      'role-only',
    ],
    [target('peer-target'), [target('peer')], 'role-only'],
  ] as const)('computes cleanup effect %s', async (subject, peers, effect) => {
    const { deps } = createDeps([subject, ...peers]);
    await deletePostgresConnection(deps, {
      ...explicitRequest,
      metadata: { ...explicitRequest.metadata, connectionId: subject.item.id },
    });
    expect(deps.runTracker.startAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ services: expect.any(Object) }),
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    if (effect === 'role-and-database')
      expect(deps.databaseOwnerRole).toHaveBeenCalledWith(resource.id, 'orders');
  });

  it('includes a peer beyond the first page in the cleanup decision', async () => {
    const peers = Array.from({ length: 50 }, (_, i) => target(`peer-${i}`));
    const subject = target('target');
    const { deps, caller } = createDeps([subject, ...peers]);
    caller.getConnections = vi
      .fn()
      .mockResolvedValueOnce({
        items: [subject.item, ...peers.slice(0, 49).map((c) => c.item)],
        limit: 50,
        offset: 0,
        total: 51,
      })
      .mockResolvedValueOnce({ items: [peers[49].item], limit: 50, offset: 50, total: 51 })
      .mockResolvedValueOnce({
        items: [subject.item, ...peers.slice(0, 49).map((c) => c.item)],
        limit: 50,
        offset: 0,
        total: 51,
      })
      .mockResolvedValueOnce({ items: [peers[49].item], limit: 50, offset: 50, total: 51 });
    await deletePostgresConnection(deps, explicitRequest);
    expect(deps.runTracker.startAndWait).toHaveBeenCalled();
  });

  it('fails 409 before starting when the approved cleanup consequence changes', async () => {
    const gate = deferred<DeleteApprovalDecision>();
    const subject = target();
    const peer = target('peer');
    const { deps, caller, approval } = createDeps([subject, peer], {
      requestApproval: vi.fn(() => gate.promise),
    });
    const pending = deletePostgresConnection(deps, explicitRequest);
    await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
    caller.getConnections = vi
      .fn()
      .mockResolvedValue({ items: [subject.item], limit: 50, offset: 0, total: 1 });
    gate.resolve({ allowed: true, connectionId: subject.item.id });
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
  });

  it('fails before cleanup when copied secret keys disappear after approval', async () => {
    const gate = deferred<DeleteApprovalDecision>();
    const secretCase = createDeps([target()], {
      requestApproval: vi.fn(() => gate.promise),
    });
    let secretLookup = 0;
    secretCase.caller.getSecretKeys = vi.fn(async () => {
      secretLookup += 1;
      const username = { key: 'USERNAME', created_at: 'now', updated_at: 'now' };
      const password = { key: 'PASSWORD', created_at: 'now', updated_at: 'now' };
      return secretLookup >= 4 ? [username] : [username, password];
    });
    const pending = deletePostgresConnection(secretCase.deps, explicitRequest);
    await vi.waitFor(() => expect(secretCase.approval).toHaveBeenCalledOnce());
    gate.resolve({ allowed: true, connectionId: 'target' });
    await expect(pending).rejects.toMatchObject({ status: 400 });
    expect(secretCase.deps.runTracker.startAndWait).not.toHaveBeenCalled();
  });

  it('rejects malformed labels and never drops the database', async () => {
    const malformed = target('target', 'consumer-1', access, {
      'postgres.access': 'database',
      'postgres.database': 'orders',
    });
    const { deps } = createDeps([malformed]);
    await expect(deletePostgresConnection(deps, explicitRequest)).rejects.toMatchObject({
      status: 409,
    });
    expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
  });

  it('does not treat an unclassified post-delete RPC failure as success', async () => {
    const { deps, caller } = createDeps([target()]);
    caller.getConnection = vi
      .fn()
      .mockResolvedValueOnce(details(target()))
      .mockResolvedValueOnce(details(target()))
      .mockRejectedValueOnce(new Error('network unavailable'));
    await expect(deletePostgresConnection(deps, explicitRequest)).rejects.toMatchObject({
      status: 500,
    });
  });
});
