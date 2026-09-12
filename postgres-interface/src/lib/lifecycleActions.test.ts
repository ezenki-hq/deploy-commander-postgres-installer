import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { createRunEventSource } from './runMonitor';
import { installPostgres, teardownPostgres, type LifecycleActionDeps } from './lifecycleActions';
import { OperationBusyError, PostgresRecoveryRequiredError } from './postgresErrors';

const resource: RPC.ResourceItem = { id: 'resource-1', type: 'postgres', name: 'postgres', external: false, manager: 'manager', created_at: 'now', updated_at: 'now' };
const run = (action: RPC.RunItem['action'], status: RPC.RunItem['status'], note = 'note'): RPC.RunItem => ({ id: `${action}-${status}`, action, status, note, queued_at: 'now', created_at: 'now', updated_at: 'now' });

function deps(overrides: Record<string, unknown> = {}): LifecycleActionDeps & { mocks: Record<string, ReturnType<typeof vi.fn>> } {
  const mocks = {
    getRuns: vi.fn().mockResolvedValue({ items: [], limit: 1, offset: 0, total: 0 }),
    getMyResources: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    start: vi.fn().mockResolvedValue({ id: 'run-started' }),
    getRun: vi.fn().mockResolvedValue({ run: { id: 'run-started', status: 2 } }),
    waitForRun: vi.fn().mockResolvedValue({ run: { id: 'run-started', status: 2 } }),
  };
  const caller = { ...mocks, ...overrides } as unknown as RPCCaller;
  return { caller, events: createRunEventSource(), signal: new AbortController().signal, waitForRun: mocks.waitForRun as never, generateCredentials: () => ({ username: 'pg_admin_0123456789abcdef0123456789abcdef', password: 'secret' }), mocks };
}

describe('database-free lifecycle actions', () => {
  it('starts installation only when latest-run state and resources are absent', async () => {
    const d = deps();
    await installPostgres(d);
    expect(d.mocks.start.mock.calls[0]).toEqual(['create', 'ezenki/deploy-commander-runner:latest', expect.any(Object), expect.stringMatching(/^postgres-install:/)]);
  });

  it('does not start installation when a resource contradicts retryable run state', async () => {
    const d = deps({ getRuns: vi.fn().mockResolvedValue({ items: [run('create', 3)], limit: 1, offset: 0, total: 1 }), getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }) });
    await expect(installPostgres(d)).rejects.toBeInstanceOf(PostgresRecoveryRequiredError);
    expect(d.mocks.start).not.toHaveBeenCalled();
  });

  it('starts teardown without reading administrator metadata', async () => {
    const d = deps({ getRuns: vi.fn().mockResolvedValue({ items: [run('create', 2)], limit: 1, offset: 0, total: 1 }), getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }), getResource: vi.fn() });
    await teardownPostgres(d);
    expect((d.caller.getResource as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(d.mocks.start).toHaveBeenCalledWith('teardown', 'ezenki/deploy-commander-runner:latest', { remove_services: ['postgres'], remove_volumes: ['postgres-data'] }, expect.stringMatching(/^postgres-teardown:/));
  });

  it('rejects active runs as busy', async () => {
    const d = deps({ getRuns: vi.fn().mockResolvedValue({ items: [run('create', 1)], limit: 1, offset: 0, total: 1 }) });
    await expect(installPostgres(d)).rejects.toBeInstanceOf(OperationBusyError);
  });
});
