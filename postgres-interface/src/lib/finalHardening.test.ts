import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { buildConnectionRunPlan } from './postgresPlans';
import {
  CATALOG_DELETE_OWNED_QUERY,
  CATALOG_MARK_CLEANUP_QUERY,
  CATALOG_UPSERT_QUERY,
  buildCatalogDeleteHook,
  confirmCatalogCleanup,
} from './postgresCatalog';
import {
  findExistingConnection,
  findLegacyPublishedConnection,
} from './postgresConnectionContract';
import { parseConnectionRequest } from './postgresConnectionRequest';
import { makeProvisionNote, parseProvisionRun } from './connectionRuns';
import { createPostgresConnection, type ConnectionWorkflowDeps } from './createPostgresConnection';
import { OperationBusyError, PostgresRecoveryRequiredError } from './postgresErrors';
import type { PlatformConnection } from './postgresContracts';
import { RunFailedError } from './runMonitor';

const platform: PlatformConnection = {
  type: 'Platform',
  data: { network: 'postgres-network' },
};
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
const administrator = {
  username: 'dc_admin_0123456789abcdef0123456789abcdef',
  password: 'admin',
};
const login = {
  username: 'dc_user_0123456789abcdef0123456789abcdef',
  password: 'secret',
};
const access = { scope: 'database', operation: 'create', database: 'orders' } as const;

function details() {
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

function workflowDeps(caller: RPCCaller, waitForRun: ConnectionWorkflowDeps['waitForRun']) {
  return {
    caller,
    events: { subscribe: vi.fn(() => vi.fn()), publish: vi.fn() },
    requestApproval: vi.fn().mockResolvedValue({ allowed: true, access }),
    generateCredentials: () => login,
    waitForRun,
    signal: new AbortController().signal,
  } as unknown as ConnectionWorkflowDeps;
}

describe('final workflow hardening', () => {
  it('round-trips an own __proto__ label through plan, lookup, and recovery', async () => {
    const metadata = parseConnectionRequest(
      JSON.parse(
        '{"action":"create-connection","scope":"database","operation":"create","database":"orders","labels":{"__proto__":"ok"}}',
      ),
    );
    expect(Object.prototype.hasOwnProperty.call(metadata.labels, '__proto__')).toBe(true);
    const plan = buildConnectionRunPlan({
      administrator,
      login,
      access,
      callerId: 'consumer-manager',
      resourceId: resource.id,
      platform,
      callerLabels: metadata.labels,
      operationId: '01234567-89ab-4def-8123-456789abcdef',
    });
    const entry = plan.connections!.create![0];
    expect(Object.prototype.hasOwnProperty.call(entry.labels, '__proto__')).toBe(true);
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'connection-1',
            manager: 'consumer-manager',
            resource: resource.id,
            external: false,
            created_at: 'now',
            updated_at: 'now',
            labels: entry.labels!,
          },
        ],
        limit: 50,
        offset: 0,
        total: 1,
      }),
      getConnection: vi.fn().mockResolvedValue({
        connection: {
          id: 'connection-1',
          manager: 'consumer-manager',
          resource: resource.id,
          external: false,
          created_at: 'now',
          updated_at: 'now',
          labels: entry.labels!,
        },
        config: {
          id: 'connection-1',
          manager: 'consumer-manager',
          resource: resource.id,
          metadata: entry.metadata,
        },
      }),
    } as unknown as RPCCaller;
    const found = await findExistingConnection(
      caller,
      {
        managerId: 'consumer-manager',
        resourceId: resource.id,
        access,
        labels: entry.labels!,
      },
      platform,
    );
    expect(found.kind).toBe('match');

    const recovered = parseProvisionRun({
      run: {
        id: 'create-connection-run',
        action: 'create-connection',
        note: makeProvisionNote({
          operationId: '01234567-89ab-4def-8123-456789abcdef',
          callerId: 'consumer-manager',
          resourceId: resource.id,
        }),
        status: 2,
        queued_at: 'now',
        created_at: 'now',
        updated_at: 'now',
      },
      config: {
        id: 'create-connection-run',
        action: 'create-connection',
        manager: 'provider-manager',
        run: 'create-connection-run',
        runner: 'ezenki/deploy-commander-runner:latest',
        metadata: plan,
      },
    });
    expect(Object.prototype.hasOwnProperty.call(recovered.labels, '__proto__')).toBe(true);
  });

  it('does not clean up when polling cannot establish terminal state', async () => {
    const caller = {
      getMyResources: vi
        .fn()
        .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      getResource: vi.fn().mockResolvedValue(details()),
      getRuns: vi.fn().mockResolvedValue({ items: [], limit: 1, offset: 0, total: 0 }),
      databaseQuery: vi.fn().mockResolvedValue({ results: [{ status: 'OK', result: [] }] }),
      getConnections: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
      start: vi.fn().mockResolvedValue({ id: 'run-1' }),
      getRun: vi.fn().mockRejectedValue(new Error('temporary transport failure')),
    } as unknown as RPCCaller;
    const waitForRun = vi.fn().mockRejectedValue(new Error('poll failed'));
    await expect(
      createPostgresConnection(workflowDeps(caller, waitForRun), {
        currentManagerId: 'provider-manager',
        callingManagerId: 'consumer-manager',
        metadata: { access, labels: {} },
      }),
    ).rejects.toBeInstanceOf(PostgresRecoveryRequiredError);
    expect(caller.start).toHaveBeenCalledTimes(1);
  });

  it('does not compensate a successful run when publication lookup is unavailable', async () => {
    const plan = buildConnectionRunPlan({
      administrator,
      login,
      access,
      callerId: 'consumer-manager',
      resourceId: resource.id,
      platform,
      callerLabels: {},
      operationId: '01234567-89ab-4def-8123-456789abcdef',
    });
    const caller = {
      getMyResources: vi
        .fn()
        .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      getResource: vi.fn().mockResolvedValue(details()),
      getRuns: vi.fn().mockResolvedValue({ items: [], limit: 1, offset: 0, total: 0 }),
      databaseQuery: vi.fn().mockResolvedValue({ results: [{ status: 'OK', result: [] }] }),
      getConnections: vi
        .fn()
        .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
        .mockRejectedValue(new Error('connection enumeration unavailable')),
      getRun: vi.fn().mockResolvedValue({
        run: {
          id: 'run-1',
          action: 'create-connection',
          note: makeProvisionNote({
            operationId: '01234567-89ab-4def-8123-456789abcdef',
            callerId: 'consumer-manager',
            resourceId: resource.id,
          }),
          status: 2,
          queued_at: 'now',
          created_at: 'now',
          updated_at: 'now',
        },
        config: {
          id: 'run-1',
          action: 'create-connection',
          manager: 'provider-manager',
          run: 'run-1',
          runner: 'ezenki/deploy-commander-runner:latest',
          metadata: plan,
        },
      }),
      start: vi.fn().mockResolvedValue({ id: 'run-1' }),
    } as unknown as RPCCaller;
    const workflow = workflowDeps(
      caller,
      vi.fn().mockResolvedValue({ run: { id: 'run-1', status: 2 } }),
    );
    await expect(
      createPostgresConnection(workflow, {
        currentManagerId: 'provider-manager',
        callingManagerId: 'consumer-manager',
        metadata: { access, labels: {} },
      }),
    ).rejects.toBeInstanceOf(PostgresRecoveryRequiredError);
    expect(caller.start).toHaveBeenCalledTimes(1);
  });

  it('returns a connection committed before an ambiguous failed-run response', async () => {
    const plan = buildConnectionRunPlan({
      administrator,
      login,
      access,
      callerId: 'consumer-manager',
      resourceId: resource.id,
      platform,
      callerLabels: {},
      operationId: '01234567-89ab-4def-8123-456789abcdef',
    });
    const published = {
      connection: {
        id: 'connection-1',
        manager: 'consumer-manager',
        resource: resource.id,
        external: false,
        created_at: 'now',
        updated_at: 'now',
        labels: { 'postgres.access': 'database', 'postgres.database': 'orders' },
      },
      config: {
        id: 'connection-1',
        manager: 'consumer-manager',
        resource: resource.id,
        metadata: plan.connections!.create![0].metadata,
      },
    };
    let runNote = '';
    const caller = {
      getMyResources: vi
        .fn()
        .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      getResource: vi.fn().mockResolvedValue(details()),
      getRuns: vi.fn().mockResolvedValue({ items: [], limit: 1, offset: 0, total: 0 }),
      databaseQuery: vi.fn().mockResolvedValue({ results: [{ status: 'OK', result: [] }] }),
      getConnections: vi
        .fn()
        .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
        .mockResolvedValue({ items: [published.connection], limit: 50, offset: 0, total: 1 }),
      getConnection: vi.fn().mockResolvedValue(published),
      getRun: vi.fn().mockImplementation(() => ({
        run: {
          id: 'run-1',
          action: 'create-connection',
          note: runNote,
          status: 3,
          queued_at: 'now',
          created_at: 'now',
          updated_at: 'now',
        },
        config: {
          id: 'run-1',
          action: 'create-connection',
          manager: 'provider-manager',
          run: 'run-1',
          metadata: plan,
        },
      })),
      start: vi.fn().mockImplementation((options: { note: string }) => {
        runNote = options.note;
        return { id: 'run-1' };
      }),
    } as unknown as RPCCaller;
    const workflow = workflowDeps(
      caller,
      vi.fn().mockRejectedValue(new RunFailedError('run-1', 3)),
    );
    await expect(
      createPostgresConnection(workflow, {
        currentManagerId: 'provider-manager',
        callingManagerId: 'consumer-manager',
        metadata: { access, labels: {} },
      }),
    ).resolves.toMatchObject({ connection: { id: 'connection-1' } });
    expect(caller.start).toHaveBeenCalledTimes(1);
  });

  it('gates a connection request while lifecycle teardown is active', async () => {
    const caller = {
      getMyResources: vi
        .fn()
        .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      getResource: vi.fn().mockResolvedValue(details()),
      getRuns: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'teardown-run',
            action: 'teardown',
            status: 1,
            queued_at: 'now',
            created_at: 'now',
            updated_at: 'now',
          },
        ],
        limit: 1,
        offset: 0,
        total: 1,
      }),
      databaseQuery: vi.fn().mockResolvedValue({ results: [{ status: 'OK', result: [] }] }),
      start: vi.fn(),
    } as unknown as RPCCaller;
    await expect(
      createPostgresConnection(workflowDeps(caller, vi.fn()), {
        currentManagerId: 'provider-manager',
        callingManagerId: 'consumer-manager',
        metadata: { access, labels: {} },
      }),
    ).rejects.toBeInstanceOf(OperationBusyError);
    expect(caller.start).not.toHaveBeenCalled();
  });

  it('also gates an active teardown before a resource is visible', async () => {
    const caller = {
      getMyResources: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
      getRuns: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'teardown-run',
            action: 'teardown',
            status: 1,
            queued_at: 'now',
            created_at: 'now',
            updated_at: 'now',
          },
        ],
        limit: 1,
        offset: 0,
        total: 1,
      }),
      start: vi.fn(),
    } as unknown as RPCCaller;
    await expect(
      createPostgresConnection(workflowDeps(caller, vi.fn()), {
        currentManagerId: 'provider-manager',
        callingManagerId: 'consumer-manager',
        metadata: { access, labels: {} },
      }),
    ).rejects.toBeInstanceOf(OperationBusyError);
    expect(caller.start).not.toHaveBeenCalled();
  });

  it('keeps legacy published connections discoverable by database and login', async () => {
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'legacy-connection',
            manager: 'consumer-manager',
            resource: resource.id,
            external: false,
            created_at: 'now',
            updated_at: 'now',
            labels: {},
          },
        ],
        limit: 50,
        offset: 0,
        total: 1,
      }),
      getConnection: vi.fn().mockResolvedValue({
        connection: {
          id: 'legacy-connection',
          manager: 'consumer-manager',
          resource: resource.id,
          external: false,
          created_at: 'now',
          updated_at: 'now',
          labels: {},
        },
        config: {
          id: 'legacy-connection',
          manager: 'consumer-manager',
          resource: resource.id,
          metadata: {
            host: 'postgres',
            port: 5432,
            database: 'db_0123456789abcdef0123456789abcdef',
            username: login.username,
            password: login.password,
            platform_connection: platform,
          },
        },
      }),
    } as unknown as RPCCaller;
    const found = await findLegacyPublishedConnection(
      caller,
      {
        managerId: 'consumer-manager',
        resourceId: resource.id,
        database: 'db_0123456789abcdef0123456789abcdef',
        username: login.username,
        password: login.password,
      },
      platform,
    );
    expect(found.kind).toBe('match');
  });

  it('requires operation ownership and confirmed cleanup before catalog deletion', async () => {
    const hook = buildCatalogDeleteHook(
      access,
      resource.id,
      '01234567-89ab-4def-8123-456789abcdef',
    );
    expect(hook?.remove?.after?.query).toBe(CATALOG_MARK_CLEANUP_QUERY);
    expect(CATALOG_DELETE_OWNED_QUERY).toContain('operation_id = $operation_id');
    expect(CATALOG_UPSERT_QUERY).toContain('created_at');
    const databaseQuery = vi.fn().mockResolvedValue({ results: [{ status: 'OK', result: [] }] });
    await confirmCatalogCleanup(
      { databaseQuery },
      resource.id,
      access.database,
      '01234567-89ab-4def-8123-456789abcdef',
    );
    expect(databaseQuery).toHaveBeenCalledWith(
      CATALOG_DELETE_OWNED_QUERY,
      expect.objectContaining({ operation_id: '01234567-89ab-4def-8123-456789abcdef' }),
    );
  });
});
