import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { installPostgres, recoverInstallationOnBoot, recoverTeardownOnBoot, teardownPostgres, type InstallationWorkflowDeps } from './installationLifecycle';
import { createRunEventSource } from './runMonitor';
import { databaseResult } from '../test/databaseQuery';

const resource: RPC.ResourceItem = {
  id: 'resource-1', type: 'postgres', name: 'postgres', external: false,
  manager: 'postgres-manager', created_at: 'now', updated_at: 'now',
};
const platform = { type: 'Platform' as const, data: { network: 'postgres-network' } };
const primaryRow = {
  phase: 'ready', operation_id: 'install-1', admin_username: 'pg_admin_0123456789abcdef0123456789abcdef', admin_password: 'secret',
  run_id: 'install-run', resource_id: 'resource-1', initialized_at: 'now', updated_at: 'now',
};

function deps(overrides: Partial<InstallationWorkflowDeps> = {}): InstallationWorkflowDeps {
  const caller = {
    getMyResources: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    getResource: vi.fn().mockResolvedValue({ config: { platform_connection: platform } }),
    getRun: vi.fn().mockResolvedValue({ run: { id: 'run-1', status: 2 } }),
    getRuns: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
      if (query.startsWith('SELECT kind')) return databaseResult([]);
      if (query.startsWith('SELECT phase')) return databaseResult([]);
      return databaseResult([bindings.operation_id ?? 'operation-1']);
    }),
    start: vi.fn().mockResolvedValue({ id: 'run-1', status: 0 }),
  } as unknown as RPCCaller;
  return {
    caller, events: createRunEventSource(), waitForRun: vi.fn().mockResolvedValue({ run: { id: 'run-1', status: 2 } }),
    signal: new AbortController().signal, generateCredentials: vi.fn().mockReturnValue({ username: 'pg_admin_0123456789abcdef0123456789abcdef', password: 'secret' }),
    managerId: 'manager-1', storage: { removeItem: vi.fn() } as unknown as Storage,
    ...overrides,
  };
}

describe('installPostgres', () => {
  it('persists private credentials before starting and transitions ready without resource secrets', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
        if (query.startsWith('SELECT kind')) return databaseResult([]);
        if (query.startsWith('SELECT phase')) return databaseResult([]);
        return databaseResult([bindings.operation_id ?? 'operation-1']);
      }),
    } as unknown as RPCCaller });
    await expect(installPostgres(d)).rejects.toThrow('already exists');
  });

  it('creates a private state record and never places credentials in runner resource metadata', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getMyResources: vi.fn()
        .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
        .mockResolvedValueOnce({ items: [resource], limit: 50, offset: 0, total: 1 }),
      databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
        if (query.startsWith('SELECT kind')) return databaseResult([]);
        if (query.startsWith('SELECT phase')) return databaseResult([]);
        return databaseResult([bindings.operation_id ?? 'operation-1']);
      }),
    } as unknown as RPCCaller });
    await installPostgres(d);
    const start = d.caller.start as unknown as ReturnType<typeof vi.fn>;
    expect(start).toHaveBeenCalledWith('create', 'ezenki/deploy-commander-runner:latest', expect.objectContaining({ services: expect.anything() }), expect.stringMatching(/^postgres-install:/));
    expect(JSON.stringify(start.mock.calls[0][2].services.postgres.resources)).not.toContain('secret');
    expect((d.caller.databaseQuery as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([query]) => String(query).startsWith('CREATE postgres_state:primary'))).toBe(true);
  });

  it('clears private state after a failed run so installation can be retried', async () => {
    const d = deps({ waitForRun: vi.fn().mockRejectedValue(Object.assign(new Error('private output'), { status: 3 })) });
    await expect(installPostgres(d)).rejects.not.toThrow(/private|secret/i);
    const calls = (d.caller.databaseQuery as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([query]) => String(query).startsWith('DELETE postgres_state:primary'))).toBe(true);
    expect(calls.some(([, b]) => b && (b as Record<string, unknown>).next_phase === 'install-failed')).toBe(false);
  });
});

describe('teardownPostgres', () => {
  it('uses a teardown journal and removes private state only after successful completion', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
        if (query.startsWith('SELECT phase')) return databaseResult([primaryRow]);
        return databaseResult([bindings.operation_id ?? 'operation-1']);
      }),
    } as unknown as RPCCaller });
    await teardownPostgres(d, resource);
    expect(d.caller.start).toHaveBeenCalledWith('teardown', 'ezenki/deploy-commander-runner:latest', { remove_services: ['postgres'], remove_volumes: ['postgres-data'] }, expect.stringMatching(/^postgres-teardown:/));
    expect((d.caller.databaseQuery as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([query]) => String(query).startsWith('DELETE postgres_state'))).toBe(true);
    expect((d.storage?.removeItem as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('retains the teardown operation on a transient monitoring failure', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
        if (query.startsWith('SELECT phase')) return databaseResult([primaryRow]);
        return databaseResult([bindings.operation_id ?? 'operation-1']);
      }),
    } as unknown as RPCCaller, waitForRun: vi.fn().mockRejectedValue(new Error('temporary')) });
    await expect(teardownPostgres(d, resource)).rejects.toThrow('teardown');
    expect((d.caller.databaseQuery as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([, b]) => b && (b as Record<string, unknown>).next_phase === 'teardown-release-required')).toBe(false);
  });

  it('retains the teardown journal when scoped permission cleanup fails', async () => {
    const databaseQuery = vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
      if (query.startsWith('SELECT phase')) return databaseResult([primaryRow]);
      return databaseResult([bindings.operation_id ?? 'operation-1']);
    });
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }), databaseQuery,
    } as unknown as RPCCaller, storage: { removeItem: vi.fn(() => { throw new Error('storage unavailable'); }) } as unknown as Storage });
    await expect(teardownPostgres(d, resource)).rejects.toThrow('lifecycle recovery is required');
    expect(databaseQuery.mock.calls.some(([, bindings]) => bindings && (bindings as Record<string, unknown>).next_phase === 'teardown-release-required')).toBe(false);
  });
});

describe('lifecycle boot recovery', () => {
  it('removes a persisted install-failed state and permits a fresh install', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
        if (query.startsWith('SELECT phase')) return databaseResult([{
          phase: 'install-failed', operation_id: 'install-1', admin_username: 'pg_admin_0123456789abcdef0123456789abcdef', admin_password: 'secret', run_id: null, resource_id: null, initialized_at: null, updated_at: 'now',
        }]);
        return databaseResult([bindings.operation_id ?? 'install-1']);
      }),
    } as unknown as RPCCaller });

    await expect(recoverInstallationOnBoot(d)).resolves.toEqual({ kind: 'retry' });
    expect((d.caller.databaseQuery as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([query]) => String(query).startsWith('DELETE postgres_state:primary'))).toBe(true);
  });

  it('reconciles an install-prepared state by exact note instead of leaving the app permanently busy', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
        if (query.startsWith('SELECT phase')) return databaseResult([{
          phase: 'install-prepared', operation_id: 'install-1', admin_username: 'pg_admin_0123456789abcdef0123456789abcdef', admin_password: 'secret', run_id: null, resource_id: null, initialized_at: null, updated_at: 'now',
        }]);
        return databaseResult([bindings.operation_id ?? 'install-1']);
      }),
      getRuns: vi.fn().mockResolvedValue({ items: [{ id: 'install-run', action: 'create', note: 'postgres-install:install-1' }], limit: 50, offset: 0, total: 1 }),
      getRun: vi.fn().mockResolvedValue({ run: { id: 'install-run', status: 1 } }),
    } as unknown as RPCCaller });
    await expect(recoverInstallationOnBoot(d)).resolves.toEqual({ kind: 'busy' });
    expect(d.caller.getRuns).toHaveBeenCalled();
  });

  it('releases a teardown journal after a terminal run without starting another teardown', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      databaseQuery: vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
        if (query.startsWith('SELECT kind')) return databaseResult([{ kind: 'teardown', operation_id: 'tear-1', resource_id: 'resource-1', phase: 'teardown-running', teardown_run_id: 'tear-run', created_at: 'now', updated_at: 'now' }]);
        if (query.startsWith('SELECT phase')) return databaseResult([primaryRow]);
        return databaseResult([bindings.operation_id ?? 'tear-1']);
      }),
      getRun: vi.fn().mockResolvedValue({ run: { id: 'tear-run', status: 2 } }),
    } as unknown as RPCCaller });
    await expect(recoverTeardownOnBoot(d)).resolves.toEqual({ kind: 'retry' });
    expect(d.caller.start).not.toHaveBeenCalled();
  });

  it('does not release a recovered teardown until permission cleanup succeeds', async () => {
    const databaseQuery = vi.fn().mockImplementation((query: string, bindings: Record<string, unknown>) => {
      if (query.startsWith('SELECT kind')) return databaseResult([{ kind: 'teardown', operation_id: 'tear-1', resource_id: 'resource-1', phase: 'teardown-running', teardown_run_id: 'tear-run', created_at: 'now', updated_at: 'now' }]);
      if (query.startsWith('SELECT phase')) return databaseResult([primaryRow]);
      return databaseResult([bindings.operation_id ?? 'tear-1']);
    });
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>), databaseQuery,
      getRun: vi.fn().mockResolvedValue({ run: { id: 'tear-run', status: 2 } }),
    } as unknown as RPCCaller, storage: { removeItem: vi.fn(() => { throw new Error('storage unavailable'); }) } as unknown as Storage });
    await expect(recoverTeardownOnBoot(d)).rejects.toThrow('lifecycle recovery is required');
    expect(databaseQuery.mock.calls.some(([, bindings]) => bindings && (bindings as Record<string, unknown>).next_phase === 'teardown-release-required')).toBe(false);
  });

  it('normalizes a release-required journal deletion failure', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      databaseQuery: vi.fn().mockImplementation((query: string) => {
        if (query.startsWith('SELECT kind')) return databaseResult([{ kind: 'teardown', operation_id: 'tear-1', resource_id: 'resource-1', phase: 'teardown-release-required', teardown_run_id: 'tear-run', created_at: 'now', updated_at: 'now' }]);
        if (query.startsWith('SELECT phase')) return databaseResult([]);
        if (query.startsWith('DELETE postgres_operation')) throw new Error('private database detail');
        return databaseResult(['tear-1']);
      }),
    } as unknown as RPCCaller });
    await expect(recoverTeardownOnBoot(d)).rejects.toThrow('PostgreSQL lifecycle recovery is required');
    await expect(recoverTeardownOnBoot(d)).rejects.not.toThrow('private database detail');
  });

  it('reports recovery when an absent starting operation cannot be released', async () => {
    const d = deps({ caller: {
      ...(deps().caller as unknown as Record<string, unknown>),
      getRuns: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
      databaseQuery: vi.fn().mockImplementation((query: string) => {
        if (query.startsWith('SELECT kind')) return databaseResult([{ kind: 'teardown', operation_id: 'tear-1', resource_id: 'resource-1', phase: 'teardown-starting', teardown_run_id: null, created_at: 'now', updated_at: 'now' }]);
        if (query.startsWith('SELECT phase')) return databaseResult([]);
        throw new Error('private mutation detail');
      }),
    } as unknown as RPCCaller });
    await expect(recoverTeardownOnBoot(d)).rejects.toThrow('PostgreSQL lifecycle recovery is required');
  });
});
