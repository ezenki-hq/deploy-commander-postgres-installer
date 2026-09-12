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
  const wait = (overrides.waitForRun as ReturnType<typeof vi.fn> | undefined) ?? mocks.waitForRun;
  return { caller, events: createRunEventSource(), signal: new AbortController().signal, waitForRun: wait as never, generateCredentials: () => ({ username: 'pg_admin_0123456789abcdef0123456789abcdef', password: 'secret' }), mocks };
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

  it('retries installation after a failed run with a fixed non-secret message', async () => {
    const d = deps({
      getRuns: vi.fn().mockResolvedValue({ items: [run('create', 3)], limit: 1, offset: 0, total: 1 }),
      waitForRun: vi.fn().mockRejectedValue(Object.assign(new Error('runner password output'), { status: 3 })),
    });
    await expect(installPostgres(d)).rejects.toThrow('PostgreSQL installation failed');
    await expect(installPostgres(d)).rejects.not.toThrow(/password|runner/);
  });

  it('retries teardown after a failed run with a fixed non-secret message', async () => {
    const d = deps({
      getRuns: vi.fn().mockResolvedValue({ items: [run('teardown', 3)], limit: 1, offset: 0, total: 1 }),
      getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      waitForRun: vi.fn().mockRejectedValue(Object.assign(new Error('secret teardown output'), { status: 3 })),
    });
    await expect(teardownPostgres(d)).rejects.toThrow('PostgreSQL teardown failed');
    await expect(teardownPostgres(d)).rejects.not.toThrow(/secret|output/);
  });

  it('preserves an abort during initial state reads', async () => {
    const controller = new AbortController();
    const d = deps({ getRuns: vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new Error('transport');
    }) });
    d.signal = controller.signal;
    await expect(installPostgres(d)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('monitors the exactly correlated run when start transport fails', async () => {
    let note = '';
    const d = deps({
      start: vi.fn().mockImplementation(async (_action: string, _runner: string, _metadata: unknown, suppliedNote: string) => {
        note = suppliedNote;
        throw new Error('transport secret');
      }),
      getRuns: vi.fn().mockImplementation(async (_a: unknown, _b: unknown, _c: unknown, _sort: unknown, limit: number, offset: number) => ({
        items: limit === 1 ? [] : (offset === 0 ? [{ ...run('create', 0, note), id: 'correlated-run' }] : []), limit, offset, total: limit === 1 ? 0 : 1,
      })),
      waitForRun: vi.fn().mockResolvedValue({ run: { id: 'correlated-run', status: 2 } }),
    });
    await installPostgres(d);
    expect((d.waitForRun as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(d.caller, d.events, 'correlated-run', expect.anything());
    await expect(Promise.resolve((d.caller.start as unknown as ReturnType<typeof vi.fn>).mock.calls[0][3])).resolves.not.toMatch(/secret/);
  });

  it('rejects ambiguous start correlation without starting a replacement', async () => {
    let note = '';
    const d = deps({
      start: vi.fn().mockImplementation(async (_action: string, _runner: string, _metadata: unknown, suppliedNote: string) => { note = suppliedNote; throw new Error('transport secret'); }),
      getRuns: vi.fn().mockImplementation(async (_a: unknown, _b: unknown, _c: unknown, _sort: unknown, limit: number, offset: number) => ({
        items: limit === 1 ? [] : (offset === 0 ? [{ ...run('create', 0, note), id: 'run-a' }, { ...run('create', 0, note), id: 'run-b' }] : []), limit, offset, total: limit === 1 ? 0 : 2,
      })),
    });
    await expect(installPostgres(d)).rejects.toBeInstanceOf(PostgresRecoveryRequiredError);
    expect((d.caller.start as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
