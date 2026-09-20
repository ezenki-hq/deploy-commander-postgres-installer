import type { RPCCaller, StartRunOptions } from '@ezenki/deploy-commander-installer-interface';
import { generateAdminCredentials, type AdminCredentials } from '../domain/credentials';
import { PostgresRequestError } from '../domain/errors';
import { buildInstallPlan, buildTeardownPlan, RUNNER_IMAGE } from '../platform/plans';
import { loadInstallationProjection, type InstallationProjection } from '../platform/resources';
import type { RunProgress, RunTracker } from '../platform/runTracker';

export type LifecycleDeps = {
  caller: RPCCaller;
  loadProjection?: () => Promise<InstallationProjection>;
  reloadProjection?: () => Promise<InstallationProjection>;
  requestConfirmation: (message: string) => Promise<boolean>;
  runTracker: RunTracker;
  generateAdminCredentials?: () => AdminCredentials;
  onProgress: (progress: RunProgress) => void;
  signal: AbortSignal;
};

function projectionLoader(deps: LifecycleDeps): () => Promise<InstallationProjection> {
  return deps.loadProjection ?? (() => loadInstallationProjection(deps.caller));
}

async function reload(deps: LifecycleDeps): Promise<InstallationProjection> {
  return (deps.reloadProjection ?? projectionLoader(deps))();
}

export async function installPostgres(deps: LifecycleDeps): Promise<void> {
  const projection = await projectionLoader(deps)();
  if (projection.kind === 'installed' || projection.kind === 'conflict') {
    throw new PostgresRequestError(
      409,
      projection.kind === 'conflict'
        ? 'Multiple PostgreSQL resources exist'
        : 'PostgreSQL is already installed',
    );
  }
  const administrator = (deps.generateAdminCredentials ?? generateAdminCredentials)();
  const options: StartRunOptions = {
    action: 'create',
    runner: RUNNER_IMAGE,
    metadata: buildInstallPlan(administrator),
    note: 'PostgreSQL installation',
  };
  await deps.runTracker.startAndWait(options, deps.onProgress, deps.signal);
  await reload(deps);
}

export async function teardownPostgres(deps: LifecycleDeps): Promise<void> {
  const projection = await projectionLoader(deps)();
  if (projection.kind === 'not-installed')
    throw new PostgresRequestError(404, 'PostgreSQL is not installed');
  if (projection.kind === 'conflict')
    throw new PostgresRequestError(409, 'Multiple PostgreSQL resources exist');
  const confirmed = await deps.requestConfirmation(
    'Teardown will remove PostgreSQL and all databases. Continue?',
  );
  if (!confirmed) return;
  await deps.runTracker.startAndWait(
    {
      action: 'teardown',
      runner: RUNNER_IMAGE,
      metadata: buildTeardownPlan(),
      note: 'PostgreSQL teardown',
      target: { kind: 'resource', id: projection.resource.id },
    },
    deps.onProgress,
    deps.signal,
  );
  await reload(deps);
}
