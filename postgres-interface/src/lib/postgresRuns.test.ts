import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import {
  findCorrelatedRun,
  listRunsByAction,
  readExactRun,
  readLatestRun,
  resolvePostgresLifecycle,
} from './postgresRuns';
import { PostgresRecoveryRequiredError } from './postgresErrors';
const run = (action: string, status: number, id = `${action}-${status}`): RPC.RunItem => ({
  id,
  action,
  status,
  note: `note-${status}`,
  queued_at: '2026-09-11T00:00:00.000Z',
  created_at: '2026-09-11T00:00:00.000Z',
  updated_at: '2026-09-11T00:00:00.000Z',
});
const c = (x: Partial<RPCCaller>) => x as RPCCaller;
describe('postgres runs', () => {
  it.each([
    [null, { kind: 'not-installed' }],
    [run('create', 0), { kind: 'installing', runId: 'create-0' }],
    [run('create', 1), { kind: 'installing', runId: 'create-1' }],
    [run('create', 2), { kind: 'installed', runId: 'create-2', operationBusy: false }],
    [run('create', 3), { kind: 'installation-failed', runId: 'create-3' }],
    [run('teardown', 0), { kind: 'tearing-down', runId: 'teardown-0' }],
    [run('teardown', 1), { kind: 'tearing-down', runId: 'teardown-1' }],
    [run('teardown', 2), { kind: 'not-installed' }],
    [run('teardown', 3), { kind: 'teardown-failed', runId: 'teardown-3' }],
    [
      run('create-connection', 0),
      { kind: 'installed', runId: 'create-connection-0', operationBusy: true },
    ],
    [
      run('create-connection', 1),
      { kind: 'installed', runId: 'create-connection-1', operationBusy: true },
    ],
    [
      run('create-connection', 2),
      { kind: 'installed', runId: 'create-connection-2', operationBusy: false },
    ],
    [
      run('create-connection', 3),
      { kind: 'installed', runId: 'create-connection-3', operationBusy: false },
    ],
    [
      run('cleanup-connection', 0),
      { kind: 'installed', runId: 'cleanup-connection-0', operationBusy: true },
    ],
    [
      run('cleanup-connection', 1),
      { kind: 'installed', runId: 'cleanup-connection-1', operationBusy: true },
    ],
    [
      run('cleanup-connection', 2),
      { kind: 'installed', runId: 'cleanup-connection-2', operationBusy: false },
    ],
    [
      run('cleanup-connection', 3),
      { kind: 'installed', runId: 'cleanup-connection-3', operationBusy: false },
    ],
  ])('resolves exact lifecycle', (input, expected) =>
    expect(resolvePostgresLifecycle(input)).toEqual(expected),
  );
  it('rejects unknown values', () => {
    expect(() => resolvePostgresLifecycle(run('unknown', 0))).toThrow();
    expect(() => resolvePostgresLifecycle(run('create', 9))).toThrow();
  });
  it('reads latest strictly', async () => {
    const getRuns = vi
      .fn()
      .mockResolvedValue({ items: [run('create', 2)], limit: 1, offset: 0, total: 1 });
    await expect(readLatestRun(c({ getRuns }))).resolves.toEqual(
      expect.objectContaining({ id: 'create-2' }),
    );
    expect(getRuns).toHaveBeenCalledWith(undefined, undefined, undefined, '-created_at', 1, 0);
  });
  it.each([
    { items: [], limit: 1, offset: 2, total: 1 },
    { items: [], limit: 1, offset: 0, total: 2 },
    { items: [run('create', 0), run('create', 1)], limit: 1, offset: 0, total: 2 },
  ])('rejects malformed page', async (p) =>
    expect(readLatestRun(c({ getRuns: vi.fn().mockResolvedValue(p) }))).rejects.toThrow(),
  );
  it('rejects items beyond total and malformed run fields', async () => {
    await expect(
      readLatestRun(
        c({
          getRuns: vi
            .fn()
            .mockResolvedValue({ items: [run('create', 0)], limit: 1, offset: 0, total: 0 }),
        }),
      ),
    ).rejects.toThrow();
    const bad = { ...run('create', 0), id: '' };
    await expect(
      readLatestRun(
        c({ getRuns: vi.fn().mockResolvedValue({ items: [bad], limit: 1, offset: 0, total: 1 }) }),
      ),
    ).rejects.toThrow();
  });
  it('validates exact run', async () => {
    const v = { run: run('create', 2, 'run-1'), config: { run: 'run-1', action: 'create' } };
    await expect(
      readExactRun(c({ getRun: vi.fn().mockResolvedValue(v) }), 'run-1'),
    ).resolves.toEqual(v);
    await expect(
      readExactRun(c({ getRun: vi.fn().mockResolvedValue(v) }), 'other'),
    ).rejects.toThrow();
    await expect(
      readExactRun(
        c({
          getRun: vi.fn().mockResolvedValue({
            ...v,
            run: { ...v.run, action: 'unknown' },
            config: { run: 'run-1', action: 'unknown' },
          }),
        }),
        'run-1',
      ),
    ).rejects.toThrow();
  });
  it('finds absent found and ambiguous across pages', async () => {
    await expect(
      findCorrelatedRun(
        c({ getRuns: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }) }),
        'create',
        'x',
      ),
    ).resolves.toEqual({ kind: 'absent' });
    await expect(
      findCorrelatedRun(
        c({
          getRuns: vi
            .fn()
            .mockResolvedValue({ items: [run('create', 2, 'r')], limit: 50, offset: 0, total: 1 }),
        }),
        'create',
        'note-2',
      ),
    ).resolves.toEqual({ kind: 'found', id: 'r' });
    const g = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          run('create', 2, 'r'),
          ...Array.from({ length: 49 }, (_, i) => run('create', 2, `x${i}`)),
        ],
        limit: 50,
        offset: 0,
        total: 51,
      })
      .mockResolvedValueOnce({ items: [run('create', 2, 'r2')], limit: 50, offset: 50, total: 51 });
    await expect(findCorrelatedRun(c({ getRuns: g }), 'create', 'note-2')).resolves.toEqual({
      kind: 'ambiguous',
    });
  });

  it('lists one action across stable pages', async () => {
    const first = Array.from({ length: 50 }, (_, index) =>
      run('cleanup-connection', 2, `cleanup-${index}`),
    );
    const getRuns = vi
      .fn()
      .mockResolvedValueOnce({ items: first, limit: 50, offset: 0, total: 51 })
      .mockResolvedValueOnce({
        items: [run('cleanup-connection', 1, 'cleanup-50')],
        limit: 50,
        offset: 50,
        total: 51,
      });
    await expect(listRunsByAction(c({ getRuns }), 'cleanup-connection')).resolves.toHaveLength(51);
    expect(getRuns).toHaveBeenNthCalledWith(1, {
      action: 'cleanup-connection',
      sort: '-created_at',
      limit: 50,
      offset: 0,
    });
  });

  it.each([
    { items: [run('create', 2)], limit: 50, offset: 0, total: 1 },
    {
      items: [run('cleanup-connection', 2, 'duplicate'), run('cleanup-connection', 2, 'duplicate')],
      limit: 50,
      offset: 0,
      total: 2,
    },
    { items: [run('cleanup-connection', 2)], limit: 50, offset: 0, total: 2 },
  ])('rejects ignored filters, duplicate ids, or malformed pages %#', async (response) => {
    await expect(
      listRunsByAction(c({ getRuns: vi.fn().mockResolvedValue(response) }), 'cleanup-connection'),
    ).rejects.toThrow(PostgresRecoveryRequiredError);
  });

  it('rejects a changed total between action pages', async () => {
    const getRuns = vi
      .fn()
      .mockResolvedValueOnce({
        items: Array.from({ length: 50 }, (_, index) => run('cleanup-connection', 2, `r-${index}`)),
        limit: 50,
        offset: 0,
        total: 51,
      })
      .mockResolvedValueOnce({
        items: [run('cleanup-connection', 2, 'r-50')],
        limit: 50,
        offset: 50,
        total: 52,
      });
    await expect(listRunsByAction(c({ getRuns }), 'cleanup-connection')).rejects.toThrow(
      PostgresRecoveryRequiredError,
    );
  });
});
