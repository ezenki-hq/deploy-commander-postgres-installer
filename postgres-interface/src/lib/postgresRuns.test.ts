import { describe, expect, it } from 'vitest';
import { resolvePostgresLifecycle } from './postgresRuns';

describe('postgres run lifecycle', () => {
  it('resolves a completed create run as installed and idle', () => {
    expect(resolvePostgresLifecycle({
      id: 'create-2', action: 'create', status: 2,
      note: 'note', queued_at: '2026-09-11T00:00:00.000Z',
      created_at: '2026-09-11T00:00:00.000Z', updated_at: '2026-09-11T00:00:00.000Z',
      started_at: '2026-09-11T00:00:01.000Z', finished_at: '2026-09-11T00:00:02.000Z',
    })).toEqual({ kind: 'installed', runId: 'create-2', operationBusy: false });
  });
});
