import type { RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import { generateAdminCredentials, type AdminCredentials } from './credentials';
import { buildInstallPlan } from './installPlan';
import { listPostgresResources } from './postgresResource';
import { findCorrelatedRun, readPostgresLifecycle } from './postgresRuns';
import { OperationBusyError, PostgresRecoveryRequiredError } from './postgresErrors';
import { waitForRun, type RunEventSource } from './runMonitor';

const RUNNER = 'ezenki/deploy-commander-runner:latest';
const TEARDOWN_PLAN = { remove_services: ['postgres'], remove_volumes: ['postgres-data'] };

export interface LifecycleActionDeps {
  caller: RPCCaller;
  events: RunEventSource;
  signal: AbortSignal;
  waitForRun?: typeof waitForRun;
  generateCredentials?: () => AdminCredentials;
}

function recovery(): PostgresRecoveryRequiredError { return new PostgresRecoveryRequiredError(); }
function aborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('PostgreSQL lifecycle operation aborted');
  error.name = 'AbortError';
  throw error;
}
function operationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') return Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) => v.toString(16).padStart(2, '0')).join('');
  throw recovery();
}
function returnedId(value: unknown): string | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'string' && (value as { id: string }).id.trim() ? (value as { id: string }).id : null;
}
function statusOf(error: unknown): unknown { return typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined; }

async function startAndWait(
  deps: LifecycleActionDeps,
  action: 'create' | 'teardown',
  metadata: unknown,
  failureMessage: string,
): Promise<void> {
  const note = `postgres-${action === 'create' ? 'install' : 'teardown'}:${operationId()}`;
  let runId = '';
  try {
    let response: unknown;
    try { response = await deps.caller.start(action, RUNNER, metadata, note); } catch {
      response = null;
    }
    runId = returnedId(response) ?? '';
    if (!runId) {
      const match = await findCorrelatedRun(deps.caller, action, note);
      if (match.kind !== 'found') throw recovery();
      runId = match.id;
    }
    aborted(deps.signal);
    await (deps.waitForRun ?? waitForRun)(deps.caller, deps.events, runId, { signal: deps.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (statusOf(error) === 3) throw new Error(failureMessage);
    throw recovery();
  }
}

export async function installPostgres(deps: LifecycleActionDeps): Promise<void> {
  aborted(deps.signal);
  const [{ lifecycle }, resources] = await Promise.all([readPostgresLifecycle(deps.caller), listPostgresResources(deps.caller)]);
  if (lifecycle.kind === 'installing' || lifecycle.kind === 'tearing-down' || (lifecycle.kind === 'installed' && lifecycle.operationBusy)) throw new OperationBusyError();
  if (resources.length !== 0 || lifecycle.kind === 'installed' || lifecycle.kind === 'teardown-failed') throw recovery();
  const credentials = (deps.generateCredentials ?? generateAdminCredentials)();
  aborted(deps.signal);
  await startAndWait(deps, 'create', buildInstallPlan(credentials), 'PostgreSQL installation failed');
}

export async function teardownPostgres(deps: LifecycleActionDeps): Promise<void> {
  aborted(deps.signal);
  const [{ lifecycle }, resources] = await Promise.all([readPostgresLifecycle(deps.caller), listPostgresResources(deps.caller)]);
  if (lifecycle.kind === 'installing' || lifecycle.kind === 'tearing-down' || (lifecycle.kind === 'installed' && lifecycle.operationBusy)) throw new OperationBusyError();
  if (resources.length === 0 || (lifecycle.kind === 'not-installed' && resources.length === 0)) throw recovery();
  await startAndWait(deps, 'teardown', TEARDOWN_PLAN, 'PostgreSQL teardown failed');
}
