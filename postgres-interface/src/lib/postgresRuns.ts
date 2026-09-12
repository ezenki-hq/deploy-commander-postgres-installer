import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { PostgresRecoveryRequiredError } from './postgresErrors';

export type RunStatus = 0 | 1 | 2 | 3;
export type PostgresLifecycle =
  | { kind: 'not-installed' }
  | { kind: 'installing'; runId: string }
  | { kind: 'installed'; runId: string; operationBusy: boolean }
  | { kind: 'installation-failed'; runId: string }
  | { kind: 'tearing-down'; runId: string }
  | { kind: 'teardown-failed'; runId: string };
export type CorrelatedRun = { kind: 'absent' } | { kind: 'ambiguous' } | { kind: 'found'; id: string };

const PAGE_LIMIT = 50;
const fail = (): PostgresRecoveryRequiredError => new PostgresRecoveryRequiredError();
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const validStatus = (v: unknown): v is RunStatus => v === 0 || v === 1 || v === 2 || v === 3;

function validRun(v: unknown): v is RPC.RunItem {
  if (!record(v) || typeof v.id !== 'string' || v.id.trim() === '' || typeof v.action !== 'string' || v.action.trim() === '' || !validStatus(v.status)) return false;
  for (const key of ['queued_at', 'created_at', 'updated_at']) if (typeof v[key] !== 'string' || v[key].trim() === '') return false;
  for (const key of ['started_at', 'finished_at', 'note']) if (v[key] !== undefined && typeof v[key] !== 'string') return false;
  return true;
}
function page(v: unknown, offset: number, limit: number): RPC.RunItem[] {
  if (!record(v) || v.limit !== limit || v.offset !== offset || !Number.isSafeInteger(v.total) || (v.total as number) < 0 || !Array.isArray(v.items) || v.items.length > limit || v.items.length > (v.total as number) || !v.items.every(validRun)) throw fail();
  if (v.items.length === 0 && (v.total as number) > offset) throw fail();
  if (v.items.length < limit && offset + v.items.length < (v.total as number)) throw fail();
  return v.items;
}

export function resolvePostgresLifecycle(latest: RPC.RunItem | null): PostgresLifecycle {
  if (latest === null) return { kind: 'not-installed' };
  if (!validRun(latest)) throw fail();
  if (latest.action === 'create') {
    if (latest.status < 2) return { kind: 'installing', runId: latest.id };
    if (latest.status === 2) return { kind: 'installed', runId: latest.id, operationBusy: false };
    return { kind: 'installation-failed', runId: latest.id };
  }
  if (latest.action === 'teardown') {
    if (latest.status < 2) return { kind: 'tearing-down', runId: latest.id };
    if (latest.status === 2) return { kind: 'not-installed' };
    return { kind: 'teardown-failed', runId: latest.id };
  }
  if (latest.action === 'create-connection' || latest.action === 'cleanup-connection') return { kind: 'installed', runId: latest.id, operationBusy: latest.status < 2 };
  throw fail();
}

export async function readLatestRun(caller: RPCCaller): Promise<RPC.RunItem | null> {
  let result: unknown;
  try { result = await caller.getRuns(undefined, undefined, undefined, '-created_at', 1, 0); } catch { throw fail(); }
  const items = page(result, 0, 1);
  return items[0] ?? null;
}
export async function readPostgresLifecycle(caller: RPCCaller) {
  const latest = await readLatestRun(caller);
  return { latest, lifecycle: resolvePostgresLifecycle(latest) };
}
export async function readExactRun(caller: RPCCaller, runId: string): Promise<RPC.GetRun> {
  let result: unknown;
  try { result = await caller.getRun(runId); } catch { throw fail(); }
  if (!record(result) || !validRun(result.run) || result.run.id !== runId || !record(result.config) || result.config.run !== runId || typeof result.config.action !== 'string' || result.config.action !== result.run.action) throw fail();
  return result as RPC.GetRun;
}
export async function findCorrelatedRun(caller: RPCCaller, action: string, note: string): Promise<CorrelatedRun> {
  const matches: string[] = [];
  for (let offset = 0;;) {
    let result: unknown;
    try { result = await caller.getRuns(undefined, undefined, undefined, undefined, PAGE_LIMIT, offset); } catch { throw fail(); }
    const items = page(result, offset, PAGE_LIMIT);
    for (const item of items) if (item.action === action && item.note === note) matches.push(item.id);
    if (items.length === 0 || offset + items.length >= (result as { total: number }).total) break;
    offset += PAGE_LIMIT;
  }
  return matches.length === 0 ? { kind: 'absent' } : matches.length === 1 ? { kind: 'found', id: matches[0] } : { kind: 'ambiguous' };
}
