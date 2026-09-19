import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import { PostgresRecoveryRequiredError } from './postgresErrors';
import { OperationBusyError } from './postgresErrors';

export type RunStatus = 0 | 1 | 2 | 3;
export type PostgresLifecycle =
  | { kind: 'not-installed' }
  | { kind: 'installing'; runId: string }
  | { kind: 'installed'; runId: string; operationBusy: boolean }
  | { kind: 'installation-failed'; runId: string }
  | { kind: 'tearing-down'; runId: string }
  | { kind: 'teardown-failed'; runId: string };
export type CorrelatedRun =
  { kind: 'absent' } | { kind: 'ambiguous' } | { kind: 'found'; id: string };

const PAGE_LIMIT = 50;
const fail = (): PostgresRecoveryRequiredError => new PostgresRecoveryRequiredError();
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const validStatus = (v: unknown): v is RunStatus => v === 0 || v === 1 || v === 2 || v === 3;
const validAction = (v: unknown): v is string =>
  v === 'create' || v === 'teardown' || v === 'create-connection' || v === 'cleanup-connection';

export type ActivePostgresRun = {
  action: 'create' | 'teardown' | 'create-connection' | 'cleanup-connection';
  runId: string;
};

function validRun(v: unknown): v is RPC.RunItem {
  if (
    !record(v) ||
    typeof v.id !== 'string' ||
    v.id.trim() === '' ||
    !validAction(v.action) ||
    !validStatus(v.status)
  )
    return false;
  for (const key of ['queued_at', 'created_at', 'updated_at'])
    if (typeof v[key] !== 'string' || v[key].trim() === '') return false;
  for (const key of ['started_at', 'finished_at', 'note'])
    if (v[key] !== undefined && typeof v[key] !== 'string') return false;
  return true;
}
function page(v: unknown, offset: number, limit: number): RPC.RunItem[] {
  if (
    !record(v) ||
    v.limit !== limit ||
    v.offset !== offset ||
    !Number.isSafeInteger(v.total) ||
    (v.total as number) < 0 ||
    !Array.isArray(v.items) ||
    v.items.length > limit ||
    v.items.length > (v.total as number) ||
    !v.items.every(validRun)
  )
    throw fail();
  if (
    offset > (v.total as number) ||
    offset + v.items.length > (v.total as number) ||
    (v.items.length === 0 && (v.total as number) > offset)
  )
    throw fail();
  if (v.items.length < limit && offset + v.items.length < (v.total as number)) throw fail();
  return v.items;
}

function resolveLegacyLifecycle(latest: RPC.RunItem | null): PostgresLifecycle {
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
  if (latest.action === 'create-connection' || latest.action === 'cleanup-connection')
    return { kind: 'installed', runId: latest.id, operationBusy: latest.status < 2 };
  throw fail();
}

export function resolvePostgresLifecycle(
  resources: RPC.ResourceItem[],
  active: ActivePostgresRun | null,
): PostgresLifecycle;
export function resolvePostgresLifecycle(latest: RPC.RunItem | null): PostgresLifecycle;
export function resolvePostgresLifecycle(
  resourcesOrLatest: RPC.ResourceItem[] | RPC.RunItem | null,
  active?: ActivePostgresRun | null,
): PostgresLifecycle {
  if (!Array.isArray(resourcesOrLatest)) return resolveLegacyLifecycle(resourcesOrLatest);
  if (active?.action === 'create') return { kind: 'installing', runId: active.runId };
  if (active?.action === 'teardown') return { kind: 'tearing-down', runId: active.runId };
  if (resourcesOrLatest.length === 0) return { kind: 'not-installed' };
  return { kind: 'installed', operationBusy: active !== null, ...(active ? { runId: active.runId } : {}) };
}

export async function readActivePostgresRun(caller: RPCCaller): Promise<ActivePostgresRun | null> {
  const active: ActivePostgresRun[] = [];
  let offset = 0;
  let total = 0;
  let first = true;
  while (first || offset < total) {
    let result: unknown;
    try {
      result = await caller.getRuns({ statuses: ['0', '1'], sort: '-created_at', limit: PAGE_LIMIT, offset });
    } catch {
      throw fail();
    }
    const items = page(result, offset, PAGE_LIMIT);
    const responseTotal = (result as { total: number }).total;
    if (first) { total = responseTotal; first = false; }
    else if (responseTotal !== total) throw fail();
    for (const item of items) {
      if (item.status !== 0 && item.status !== 1) throw fail();
      if (validAction(item.action)) active.push({ action: item.action, runId: item.id });
    }
    if (items.length === 0 && total === 0) break;
    offset += items.length;
  }
  if (active.length > 1) throw new OperationBusyError();
  return active[0] ?? null;
}

export async function readLatestRun(caller: RPCCaller): Promise<RPC.RunItem | null> {
  let result: unknown;
  try {
    result = await caller.getRuns(undefined, undefined, undefined, '-created_at', 1, 0);
  } catch {
    throw fail();
  }
  const items = page(result, 0, 1);
  return items[0] ?? null;
}

export async function listRunsByAction(
  caller: RPCCaller,
  action: 'cleanup-connection',
): Promise<RPC.RunItem[]> {
  const runs: RPC.RunItem[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | null = null;
  for (let offset = 0; ; offset += PAGE_LIMIT) {
    let response: unknown;
    try {
      response = await caller.getRuns({
        action,
        sort: '-created_at',
        limit: PAGE_LIMIT,
        offset,
      });
    } catch {
      throw fail();
    }
    const items = page(response, offset, PAGE_LIMIT);
    const total = (response as { total: number }).total;
    if (expectedTotal === null) expectedTotal = total;
    if (total !== expectedTotal) throw fail();
    for (const item of items) {
      if (item.action !== action || seen.has(item.id)) throw fail();
      seen.add(item.id);
      runs.push(item);
    }
    if (offset + items.length >= total) break;
  }
  return runs;
}
export async function readPostgresLifecycle(caller: RPCCaller) {
  const latest = await readLatestRun(caller);
  return { latest, lifecycle: resolvePostgresLifecycle(latest) };
}
export async function readExactRun(caller: RPCCaller, runId: string): Promise<RPC.GetRun> {
  let result: unknown;
  try {
    result = await caller.getRun(runId);
  } catch {
    throw fail();
  }
  if (
    !record(result) ||
    !validRun(result.run) ||
    result.run.id !== runId ||
    !record(result.config) ||
    result.config.run !== runId ||
    typeof result.config.action !== 'string' ||
    result.config.action !== result.run.action
  )
    throw fail();
  return result as unknown as RPC.GetRun;
}
export async function findCorrelatedRun(
  caller: RPCCaller,
  action: string,
  note: string,
): Promise<CorrelatedRun> {
  const matches: string[] = [];
  for (let offset = 0; ;) {
    let result: unknown;
    try {
      result = await caller.getRuns(undefined, undefined, undefined, undefined, PAGE_LIMIT, offset);
    } catch {
      throw fail();
    }
    const items = page(result, offset, PAGE_LIMIT);
    for (const item of items)
      if (item.action === action && item.note === note) matches.push(item.id);
    if (items.length === 0 || offset + items.length >= (result as { total: number }).total) break;
    offset += PAGE_LIMIT;
  }
  return matches.length === 0
    ? { kind: 'absent' }
    : matches.length === 1
      ? { kind: 'found', id: matches[0] }
      : { kind: 'ambiguous' };
}
