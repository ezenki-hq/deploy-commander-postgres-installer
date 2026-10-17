import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import { describe, expect, it, vi } from 'vitest';
import { PostgresRequestError } from '../domain/errors';
import type { LoginCredentials } from '../domain/credentials';
import type { AccessRequest } from '../domain/requests';
import type { PostgresConnection } from '../platform/connections';
import type { PostgresInstallation } from '../platform/resources';
import { RunFailedError } from '../platform/runTracker';
import { deferred, fakeCaller } from '../test/fakes';
import {
  createPostgresConnection,
  type CreateApprovalDecision,
  type CreateConnectionDeps,
} from './createConnection';

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
const installation: PostgresInstallation = {
  resource,
};
const request = {
  currentManagerId: 'postgres-manager',
  callingManagerId: 'consumer-1',
  metadata: {
    action: 'create-connection' as const,
    resourceId: 'resource-1',
    requestedAccess: {
      scope: 'database' as const,
      operation: 'create' as const,
      database: 'orders',
    },
    labels: { team: 'payments' },
  },
};
const summary = (id: string, labels: Record<string, string> = {}): RPC.ConnectionItem => ({
  id,
  manager: 'consumer-1',
  resource: 'resource-1',
  external: false,
  created_at: '2026-09-20T00:00:00Z',
  updated_at: '2026-09-20T00:00:00Z',
  labels,
});
const connection = (
  id: string,
  access: AccessRequest = request.metadata.requestedAccess,
  labels = summary(id).labels,
): PostgresConnection => ({
  item: summary(
    id,
    Object.keys(labels ?? {}).length
      ? (labels ?? {})
      : {
          team: 'payments',
          'postgres.access': 'database',
          'postgres.database': 'orders',
          'postgres.database-origin': 'managed',
        },
  ),
  managerId: 'consumer-1',
  resourceId: 'resource-1',
  authority:
    access.scope === 'database'
      ? { access: 'database', database: access.database, origin: 'managed' }
      : { access: 'full' },
  access,
  metadata: {
    access,
    secret_keys: ['USERNAME', 'PASSWORD'],
  },
});
const details = (item: PostgresConnection): RPC.GetConnection => ({
  connection: item.item,
  config: {
    id: item.item.id,
    manager: item.managerId,
    resource: item.resourceId,
    metadata: item.metadata,
  },
});

function createDeps(overrides: Partial<CreateConnectionDeps> = {}) {
  const approval = vi.fn(async (): Promise<CreateApprovalDecision> => ({
    allowed: true,
    access: request.metadata.requestedAccess,
  }));
  const caller = fakeCaller({
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
        metadata: { engine: 'postgres', version: '15', secret_keys: ['USERNAME', 'PASSWORD'] },
      },
    }),
    getConnections: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    getConnection: vi.fn(),
  });
  const deps: CreateConnectionDeps = {
    caller,
    requestApproval: approval,
    runTracker: {
      startAndWait: vi
        .fn()
        .mockResolvedValue({ run: { status: 2, finished_at: 'now' }, config: {} }),
      dispose: vi.fn(),
    },
    generateLoginCredentials: vi.fn(async (): Promise<LoginCredentials> => ({
      username: `dc_user_${'c'.repeat(32)}`,
      password: 'new-secret',
    })),
    databaseOwnerRole: vi.fn(async () => `dc_db_${'d'.repeat(32)}`),
    signal: new AbortController().signal,
    ...overrides,
  };
  return { deps, caller, approval: deps.requestApproval as typeof approval };
}

describe('createPostgresConnection', () => {
  it('does not generate credentials or start before approval', async () => {
    const gate = deferred<CreateApprovalDecision>();
    const { deps, approval } = createDeps({ requestApproval: vi.fn(() => gate.promise) });
    const pending = createPostgresConnection(deps, request);
    await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
    expect(deps.caller.start).not.toHaveBeenCalled();
    expect(deps.generateLoginCredentials).not.toHaveBeenCalled();
    expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
    gate.resolve({ allowed: false });
    await expect(pending).rejects.toMatchObject({ status: 499 });
  });

  it('requires approval before returning an exact existing connection', async () => {
    const gate = deferred<CreateApprovalDecision>();
    const existing = connection('connection-1');
    const { deps, caller, approval } = createDeps({
      requestApproval: vi.fn(() => gate.promise),
    });
    caller.getConnections = vi
      .fn()
      .mockResolvedValue({ items: [existing.item], limit: 50, offset: 0, total: 1 });
    caller.getConnection = vi.fn().mockResolvedValue(details(existing));
    const pending = createPostgresConnection(deps, request);
    await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
    gate.resolve({ allowed: true, access: request.metadata.requestedAccess });
    await expect(pending).resolves.toEqual({ connection: existing.item });
    expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
  });

  it('rejects a missing or mismatched requested resource before approval', async () => {
    const missing = createDeps();
    missing.caller.getResource = vi.fn().mockRejectedValue(new Error('not found'));
    await expect(createPostgresConnection(missing.deps, request)).rejects.toMatchObject({
      status: 400,
    });
    const wrongResource = createDeps();
    const wrongRequest = {
      ...request,
      metadata: { ...request.metadata, resourceId: 'resource-2' },
    };
    await expect(createPostgresConnection(wrongResource.deps, wrongRequest)).rejects.toMatchObject({
      status: 400,
    });
    expect(wrongResource.approval).not.toHaveBeenCalled();
  });

  it('requires both resource secret keys before approval', async () => {
    const { deps, approval } = createDeps();
    deps.caller.getSecretKeys = vi.fn().mockResolvedValue(['USERNAME']);
    await expect(createPostgresConnection(deps, request)).rejects.toMatchObject({ status: 400 });
    expect(approval).not.toHaveBeenCalled();
    expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
  });

  it('passes labels-only requests through the approval decision', async () => {
    const labelsOnly = {
      ...request,
      metadata: {
        action: 'create-connection' as const,
        resourceId: 'resource-1',
        requestedAccess: null,
        labels: { team: 'payments' },
      },
    };
    const { deps, approval } = createDeps({
      requestApproval: vi.fn(async (context) => {
        expect(context.requestedAccess).toBeNull();
        return { allowed: false as const };
      }),
    });
    await expect(createPostgresConnection(deps, labelsOnly)).rejects.toMatchObject({ status: 499 });
    expect(approval).toHaveBeenCalledOnce();
  });

  it('rejects an incompatible existing identity after approval', async () => {
    const existing = connection('connection-1', {
      scope: 'database',
      operation: 'existing',
      database: 'orders',
    });
    const { deps, caller } = createDeps();
    caller.getConnections = vi
      .fn()
      .mockResolvedValue({ items: [existing.item], limit: 50, offset: 0, total: 1 });
    caller.getConnection = vi.fn().mockResolvedValue(details(existing));
    await expect(createPostgresConnection(deps, request)).rejects.toMatchObject({ status: 409 });
  });

  it('starts a managed provision and returns the exact created connection', async () => {
    const created = connection('connection-created', request.metadata.requestedAccess, {
      team: 'payments',
      'postgres.access': 'database',
      'postgres.database': 'orders',
      'postgres.database-origin': 'managed',
    });
    const { deps, caller } = createDeps();
    caller.getConnections = vi
      .fn()
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
      .mockResolvedValueOnce({ items: [created.item], limit: 50, offset: 0, total: 1 });
    caller.getConnection = vi.fn().mockResolvedValue(details(created));
    await expect(createPostgresConnection(deps, request)).resolves.toEqual({ connection: created.item });
    expect(deps.runTracker.startAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create-connection',
        runner: 'ezenki/deploy-commander-runner:latest',
        target: { kind: 'resource', id: 'resource-1' },
        note: expect.not.stringContaining('new-secret'),
        secrets: { USERNAME: `dc_user_${'c'.repeat(32)}`, PASSWORD: 'new-secret' },
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });

  it('creates a distinct group-scoped login when another group has the same access', async () => {
    const groupRequest = {
      ...request,
      metadata: {
        ...request.metadata,
        labels: {
          team: 'payments',
          custom_deployer_group_id: 'group-a',
          custom_deployer_connection_origin: 'created',
        },
      },
    };
    const otherGroup = connection('connection-b', request.metadata.requestedAccess, {
      team: 'payments',
      custom_deployer_group_id: 'group-b',
      custom_deployer_connection_origin: 'created',
      'postgres.access': 'database',
      'postgres.database': 'orders',
      'postgres.database-origin': 'managed',
    });
    const { deps, caller } = createDeps();
    caller.getConnections = vi
      .fn()
      .mockResolvedValueOnce({ items: [otherGroup.item], limit: 50, offset: 0, total: 1 })
      .mockResolvedValueOnce({ items: [otherGroup.item], limit: 50, offset: 0, total: 1 })
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
      .mockResolvedValueOnce({ items: [connection('connection-a', request.metadata.requestedAccess, {
        team: 'payments',
        custom_deployer_group_id: 'group-a',
        custom_deployer_connection_origin: 'created',
        'postgres.access': 'database',
        'postgres.database': 'orders',
        'postgres.database-origin': 'managed',
      }).item], limit: 50, offset: 0, total: 1 });
    caller.getConnection = vi.fn((id: string) =>
      Promise.resolve(details(id === 'connection-b' ? otherGroup : connection('connection-a', request.metadata.requestedAccess, {
        team: 'payments',
        custom_deployer_group_id: 'group-a',
        custom_deployer_connection_origin: 'created',
        'postgres.access': 'database',
        'postgres.database': 'orders',
        'postgres.database-origin': 'managed',
      }))),
    );
    await expect(createPostgresConnection(deps, groupRequest)).resolves.toMatchObject({
      connection: { id: 'connection-a' },
    });
    expect(deps.generateLoginCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'group-a' }),
    );
    expect(deps.runTracker.startAndWait).toHaveBeenCalledOnce();
  });

  it('waits for the created connection to become visible after the run completes', async () => {
    const created = connection('connection-created', request.metadata.requestedAccess, {
      team: 'payments',
      'postgres.access': 'database',
      'postgres.database': 'orders',
      'postgres.database-origin': 'managed',
    });
    const { deps, caller } = createDeps();
    caller.getConnections = vi
      .fn()
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
      .mockResolvedValueOnce({ items: [created.item], limit: 50, offset: 0, total: 1 });
    caller.getConnection = vi.fn().mockResolvedValue(details(created));

    await expect(createPostgresConnection(deps, request)).resolves.toEqual({ connection: created.item });
    expect(caller.getConnections).toHaveBeenCalledTimes(5);
  });

  it('reports when the new record is visible with incompatible settings', async () => {
    const incompatible = connection('connection-created', request.metadata.requestedAccess, {
      team: 'engineering',
      'postgres.access': 'database',
      'postgres.database': 'orders',
      'postgres.database-origin': 'managed',
    });
    const { deps, caller } = createDeps();
    caller.getConnections = vi
      .fn()
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
      .mockResolvedValueOnce({ items: [incompatible.item], limit: 50, offset: 0, total: 1 });
    caller.getConnection = vi.fn().mockResolvedValue(details(incompatible));

    await expect(createPostgresConnection(deps, request)).rejects.toMatchObject({
      status: 500,
      message: 'PostgreSQL connection was persisted with incompatible settings',
    });
  });

  it.each([
    ['database-not-found', 404],
    ['database-collision', 409],
    ['postgres-unavailable', 500],
    [null, 500],
  ] as const)('maps run marker %s to status %s', async (marker, status) => {
    const { deps } = createDeps({
      runTracker: {
        startAndWait: vi.fn().mockRejectedValue(new RunFailedError('run-1', marker)),
        dispose: vi.fn(),
      },
    });
    await expect(createPostgresConnection(deps, request)).rejects.toMatchObject({ status });
    try {
      await createPostgresConnection(deps, request);
    } catch (error) {
      expect(error).toBeInstanceOf(PostgresRequestError);
      expect((error as Error).message).not.toContain('POSTGRES_MANAGER_ERROR');
    }
  });
});
