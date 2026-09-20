import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CreateConnectionDialog } from '../components/CreateConnectionDialog';
import { Dashboard } from '../components/Dashboard';
import { DeleteConnectionDialog } from '../components/DeleteConnectionDialog';
import { ManagerShell } from '../components/ManagerShell';
import { ProgressPanel } from '../components/ProgressPanel';
import { TeardownDialog } from '../components/TeardownDialog';
import { parseCreateRequest, parseDeleteRequest } from '../domain/requests';
import { PostgresRequestError } from '../domain/errors';
import { createInterfaceClient, type InterfaceClient } from '../platform/interfaceClient';
import {
  loadDashboardProjection,
  type DashboardProjection,
} from '../platform/dashboardProjection';
import type { InstallationProjection } from '../platform/resources';
import { createRunTracker, type RunProgress } from '../platform/runTracker';
import {
  createPostgresConnection,
  type CreateApprovalContext,
  type CreateApprovalDecision,
  type CreateConnectionDeps,
} from '../workflows/createConnection';
import {
  deletePostgresConnection,
  type DeleteApprovalContext,
  type DeleteApprovalDecision,
  type DeleteConnectionDeps,
} from '../workflows/deleteConnection';
import { installPostgres, teardownPostgres, type LifecycleDeps } from '../workflows/lifecycle';
import { useDecisionController } from './useDecisionController';

export interface AppServices {
  createConnection: typeof createPostgresConnection;
  deleteConnection: typeof deletePostgresConnection;
  install: typeof installPostgres;
  teardown: typeof teardownPostgres;
}

type Props = {
  client?: InterfaceClient;
  services?: AppServices;
  loadDashboard?: typeof loadDashboardProjection;
};
type Boot = { managerId: string; callingManagerId: string | null; metadata: unknown };

function statusOf(error: unknown): number {
  return error instanceof PostgresRequestError ? error.status : 500;
}

function rootErrorMessage(error: unknown): string {
  return error instanceof PostgresRequestError
    ? error.message
    : 'Unable to load PostgreSQL manager state';
}

function RootFailure({ status, message }: { status: number; message: string }) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm leading-6 text-rose-800 shadow-sm"
    >
      <p className="font-semibold">PostgreSQL manager request failed ({status})</p>
      <p className="mt-1">{message}</p>
    </div>
  );
}

function badgeFor(projection: DashboardProjection | null) {
  if (!projection) return { label: 'Loading', tone: 'progress' as const };
  if (projection.installation.kind === 'installed') return { label: 'Installed', tone: 'success' as const };
  if (projection.installation.kind === 'conflict') return { label: 'Attention required', tone: 'danger' as const };
  return { label: 'Not installed', tone: 'warning' as const };
}

export default function App({
  client: providedClient,
  services,
  loadDashboard: providedLoadDashboard,
}: Props) {
  const client = useMemo(() => providedClient ?? createInterfaceClient(), [providedClient]);
  const tracker = useMemo(() => createRunTracker(client.caller, client.events), [client]);
  const decisions = useDecisionController();
  const defaultServices = useMemo<AppServices>(
    () => ({
      createConnection: createPostgresConnection,
      deleteConnection: deletePostgresConnection,
      install: installPostgres,
      teardown: teardownPostgres,
    }),
    [],
  );
  const appServices = services ?? defaultServices;
  const loadDashboard = providedLoadDashboard ?? loadDashboardProjection;
  const [boot, setBoot] = useState<Boot | null>(null);
  const [bootError, setBootError] = useState<unknown>(null);
  const [projection, setProjection] = useState<DashboardProjection | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [rootError, setRootError] = useState<string | null>(null);
  const [rootBusy, setRootBusy] = useState(false);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const lifecycleAbort = useRef<AbortController | null>(null);

  const [approval, setApproval] = useState<CreateApprovalContext | DeleteApprovalContext | null>(
    null,
  );
  const approvalResolve = useRef<
    ((decision: CreateApprovalDecision | DeleteApprovalDecision) => void) | null
  >(null);
  const ranChild = useRef(false);

  useEffect(() => {
    let live = true;
    void Promise.all([
      client.caller.getManager(),
      client.caller.getCallingManager(),
      client.caller.getMetadata(),
    ])
      .then(([managerId, callingManagerId, metadata]) => {
        if (live) setBoot({ managerId, callingManagerId, metadata });
      })
      .catch((error) => live && setBootError(error));
    return () => {
      live = false;
      lifecycleAbort.current?.abort();
      tracker.dispose();
      client.dispose();
    };
  }, [client, tracker]);

  const readDashboard = useCallback(
    async (knownInstallation?: Parameters<typeof loadDashboardProjection>[1]) => {
      try {
        const next = await loadDashboard(client.caller, knownInstallation);
        setProjection(next);
        setRootError(null);
        return next;
      } catch (error) {
        setRootError(rootErrorMessage(error));
        throw error;
      } finally {
        setDashboardLoading(false);
      }
    },
    [client.caller, loadDashboard],
  );

  useEffect(() => {
    if (!boot || boot.callingManagerId !== null || projection) return;
    const refresh = window.setTimeout(() => {
      void readDashboard().catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(refresh);
  }, [boot, projection, readDashboard]);

  const closeFailure = useCallback(
    (error: unknown) => {
      client.wire.close({
        manager: boot?.managerId ?? 'postgres',
        ok: false,
        error: {
          message:
            error instanceof PostgresRequestError
              ? error.message
              : 'PostgreSQL manager operation failed',
          status: statusOf(error),
        },
      });
    },
    [boot?.managerId, client.wire],
  );
  const resolveApproval = useCallback(
    (decision: CreateApprovalDecision | DeleteApprovalDecision) => {
      setApproval(null);
      const resolve = approvalResolve.current;
      approvalResolve.current = null;
      resolve?.(decision);
    },
    [],
  );
  const requestApproval = useCallback(
    <T extends CreateApprovalContext | DeleteApprovalContext>(context: T) => {
      setApproval(context);
      return new Promise<CreateApprovalDecision | DeleteApprovalDecision>((resolve) => {
        approvalResolve.current = resolve;
      });
    },
    [],
  );
  const onProgress = useCallback((next: RunProgress) => setProgress(next), []);

  useEffect(() => {
    if (!boot || boot.callingManagerId === null || ranChild.current) return;
    ranChild.current = true;
    const callingManagerId = boot.callingManagerId;
    const run = async () => {
      try {
        const metadata = boot.metadata as Record<string, unknown>;
        if (metadata.action === 'create-connection') {
          const parsed = parseCreateRequest(metadata);
          const deps: CreateConnectionDeps = {
            caller: client.caller,
            runTracker: tracker,
            requestApproval: (context) =>
              requestApproval(context) as Promise<CreateApprovalDecision>,
            onProgress,
            signal: new AbortController().signal,
          };
          const result = await appServices.createConnection(deps, {
            currentManagerId: boot.managerId,
            callingManagerId,
            metadata: parsed,
          });
          client.wire.close({ manager: boot.managerId, ok: true, result });
        } else if (metadata.action === 'delete-connection') {
          const parsed = parseDeleteRequest(metadata);
          const deps: DeleteConnectionDeps = {
            caller: client.caller,
            runTracker: tracker,
            requestApproval: (context) =>
              requestApproval(context) as Promise<DeleteApprovalDecision>,
            onProgress,
            signal: new AbortController().signal,
          };
          const result = await appServices.deleteConnection(deps, {
            currentManagerId: boot.managerId,
            callingManagerId,
            metadata: parsed,
          });
          client.wire.close({ manager: boot.managerId, ok: true, result });
        } else {
          throw new PostgresRequestError(400, 'Unsupported PostgreSQL action');
        }
      } catch (error) {
        closeFailure(error);
      }
    };
    void run();
  }, [
    appServices,
    boot,
    client.caller,
    client.wire,
    closeFailure,
    onProgress,
    requestApproval,
    tracker,
  ]);

  const runLifecycle = useCallback(
    (operation: (deps: LifecycleDeps) => Promise<InstallationProjection>) => {
      if (rootBusy) return;
      const controller = new AbortController();
      lifecycleAbort.current = controller;
      setRootBusy(true);
      setRootError(null);
      setProgress(null);
      const deps: LifecycleDeps = {
        caller: client.caller,
        runTracker: tracker,
        requestConfirmation: decisions.requestTeardown,
        onProgress,
        signal: controller.signal,
      };
      void operation(deps)
        .then((next) => readDashboard(next))
        .catch((error) => setRootError(rootErrorMessage(error)))
        .finally(() => {
          if (lifecycleAbort.current === controller) lifecycleAbort.current = null;
          setRootBusy(false);
          setProgress(null);
        });
    },
    [client.caller, decisions.requestTeardown, onProgress, readDashboard, rootBusy, tracker],
  );
  const runInstall = useCallback(() => {
    runLifecycle(appServices.install);
  }, [appServices.install, runLifecycle]);
  const runTeardown = useCallback(() => {
    runLifecycle(appServices.teardown);
  }, [appServices.teardown, runLifecycle]);

  if (bootError) {
    return (
      <ManagerShell badge={{ label: 'Unavailable', tone: 'danger' }}>
        <RootFailure status={statusOf(bootError)} message={rootErrorMessage(bootError)} />
      </ManagerShell>
    );
  }
  if (!boot) {
    return (
      <ManagerShell badge={{ label: 'Loading', tone: 'progress' }}>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
          Loading PostgreSQL manager state…
        </div>
      </ManagerShell>
    );
  }
  if (boot.callingManagerId === null) {
    return (
      <ManagerShell badge={badgeFor(projection)}>
        {dashboardLoading && !projection ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
            Loading PostgreSQL state…
          </div>
        ) : projection ? (
          <>
            <Dashboard
              projection={projection}
              onInstall={runInstall}
              onTeardown={runTeardown}
              busy={rootBusy}
              error={rootError}
            />
            {progress && <div className="mt-6"><ProgressPanel progress={progress} /></div>}
          </>
        ) : (
          <RootFailure
            status={500}
            message={rootError ?? 'Unable to load PostgreSQL manager state'}
          />
        )}
        {decisions.pending?.kind === 'teardown' && (
          <TeardownDialog busy={false} onDecision={decisions.decideTeardown} />
        )}
      </ManagerShell>
    );
  }
  return (
    <ManagerShell badge={{ label: 'Action requested', tone: 'progress' }}>
      {approval &&
        ('choices' in approval ? (
          <DeleteConnectionDialog context={approval} onDecision={resolveApproval} />
        ) : (
          <CreateConnectionDialog context={approval} onDecision={resolveApproval} />
        ))}
      {progress && <ProgressPanel progress={progress} />}
    </ManagerShell>
  );
}
