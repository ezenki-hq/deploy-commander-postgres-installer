import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CreateConnectionDialog } from '../components/CreateConnectionDialog';
import { Dashboard } from '../components/Dashboard';
import { DeleteConnectionDialog } from '../components/DeleteConnectionDialog';
import { ManagerShell } from '../components/ManagerShell';
import { ModalDialog } from '../components/ModalDialog';
import { ProgressPanel } from '../components/ProgressPanel';
import { TeardownDialog } from '../components/TeardownDialog';
import { ActionButton } from '../components/ActionButton';
import { parseCreateRequest, parseDeleteRequest } from '../domain/requests';
import { PostgresRequestError } from '../domain/errors';
import { createInterfaceClient, type InterfaceClient } from '../platform/interfaceClient';
import { loadDashboardProjection, type DashboardProjection } from '../platform/dashboardProjection';
import type { InstallationProjection } from '../platform/resources';
import { createRunTracker, type RunProgress } from '../platform/runTracker';
import {
  createPostgresConnection,
  type CreateConnectionDeps,
  type CreateApprovalContext,
} from '../workflows/createConnection';
import {
  deletePostgresConnection,
  type DeleteApprovalContext,
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

export type ChildViewState =
  | { kind: 'preparing' }
  | { kind: 'create-approval'; context: CreateApprovalContext }
  | { kind: 'delete-approval'; context: DeleteApprovalContext }
  | { kind: 'progress'; progress: RunProgress }
  | { kind: 'failure'; status: number; message: string };

function statusOf(error: unknown): number {
  return error instanceof PostgresRequestError ? error.status : 500;
}

function rootErrorMessage(error: unknown): string {
  return error instanceof PostgresRequestError
    ? error.message
    : 'Unable to load PostgreSQL manager state';
}

function childErrorMessage(error: unknown): string {
  return error instanceof PostgresRequestError
    ? error.message
    : 'PostgreSQL manager operation failed';
}

function ChildFailureDialog({
  status,
  message,
  onClose,
}: {
  status: number;
  message: string;
  onClose: () => void;
}) {
  return (
    <ModalDialog
      title={`PostgreSQL operation failed (${status})`}
      description="The requested PostgreSQL operation could not be prepared."
      onCancel={onClose}
      tone="danger"
      actions={
        <ActionButton tone="secondary" onClick={onClose}>
          Close
        </ActionButton>
      }
    >
      <p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-900">
        {message}
      </p>
    </ModalDialog>
  );
}

function RootFailure({
  status,
  message,
  onRetry,
}: {
  status: number;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm leading-6 text-rose-800 shadow-sm"
    >
      <p className="font-semibold">PostgreSQL manager request failed ({status})</p>
      <p className="mt-1">{message}</p>
      {onRetry && (
        <ActionButton className="mt-4" tone="secondary" onClick={onRetry}>
          Retry
        </ActionButton>
      )}
    </div>
  );
}

function badgeFor(projection: DashboardProjection | null) {
  if (!projection) return { label: 'Loading', tone: 'progress' as const };
  if (projection.installation.kind === 'installed')
    return { label: 'Installed', tone: 'success' as const };
  if (projection.installation.kind === 'conflict')
    return { label: 'Attention required', tone: 'danger' as const };
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
  const {
    pending: pendingDecision,
    requestCreate,
    requestDelete,
    requestTeardown,
    decideCreate,
    decideDelete,
    decideTeardown,
  } = decisions;
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
  const mounted = useRef(false);
  const lifecycleAbort = useRef<AbortController | null>(null);
  const [childState, setChildState] = useState<ChildViewState | null>(null);
  const childAbort = useRef<AbortController | null>(null);
  const childClosed = useRef(false);
  const ranChild = useRef(false);

  useEffect(() => {
    let live = true;
    mounted.current = true;
    void Promise.all([
      client.caller.getManager(),
      client.caller.getCallingManager(),
      client.caller.getMetadata(),
    ])
      .then(([managerId, callingManagerId, metadata]) => {
        if (live && mounted.current) setBoot({ managerId, callingManagerId, metadata });
      })
      .catch((error) => live && mounted.current && setBootError(error));
    return () => {
      live = false;
      mounted.current = false;
      lifecycleAbort.current?.abort();
      tracker.dispose();
      client.dispose();
    };
  }, [client, tracker]);

  const readDashboard = useCallback(
    async (knownInstallation?: Parameters<typeof loadDashboardProjection>[1]) => {
      if (mounted.current) setDashboardLoading(true);
      try {
        const next = await loadDashboard(client.caller, knownInstallation);
        if (!mounted.current) return next;
        setProjection(next);
        setRootError(null);
        return next;
      } catch (error) {
        if (mounted.current) setRootError(rootErrorMessage(error));
        throw error;
      } finally {
        if (mounted.current) setDashboardLoading(false);
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
    (status: number, message: string) => {
      if (childClosed.current) return;
      childClosed.current = true;
      client.wire.close({
        manager: boot?.managerId ?? 'postgres',
        ok: false,
        error: { message, status },
      });
    },
    [boot?.managerId, client.wire],
  );
  const onRootProgress = useCallback((next: RunProgress) => setProgress(next), []);

  useEffect(() => {
    if (!boot || boot.callingManagerId === null || ranChild.current) return;
    ranChild.current = true;
    const controller = new AbortController();
    childAbort.current = controller;
    setChildState({ kind: 'preparing' });
    const callingManagerId = boot.callingManagerId;
    const run = async () => {
      try {
        const metadata = boot.metadata as Record<string, unknown>;
        if (metadata.action === 'create-connection') {
          const parsed = parseCreateRequest(metadata);
          const deps: CreateConnectionDeps = {
            caller: client.caller,
            runTracker: tracker,
            requestApproval: (context) => {
              setChildState({ kind: 'create-approval', context });
              return requestCreate(context);
            },
            onProgress: (next) => {
              setChildState({ kind: 'progress', progress: next });
            },
            signal: controller.signal,
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
            requestApproval: (context) => {
              setChildState({ kind: 'delete-approval', context });
              return requestDelete(context);
            },
            onProgress: (next) => {
              setChildState({ kind: 'progress', progress: next });
            },
            signal: controller.signal,
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
        const status = statusOf(error);
        const message = childErrorMessage(error);
        setChildState({
          kind: 'failure',
          status,
          message,
        });
        if (status === 499) closeFailure(status, message);
      }
    };
    void run();
    return () => {
      controller.abort();
      if (childAbort.current === controller) childAbort.current = null;
    };
  }, [
    appServices,
    boot,
    client.caller,
    client.wire,
    closeFailure,
    requestCreate,
    requestDelete,
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
        requestConfirmation: requestTeardown,
        onProgress: onRootProgress,
        signal: controller.signal,
      };
      void operation(deps)
        .then(async (next) => {
          if (mounted.current) await readDashboard(next);
        })
        .catch((error) => {
          if (mounted.current) setRootError(rootErrorMessage(error));
        })
        .finally(() => {
          if (!mounted.current) return;
          if (lifecycleAbort.current === controller) lifecycleAbort.current = null;
          setRootBusy(false);
          setProgress(null);
        });
    },
    [client.caller, onRootProgress, readDashboard, requestTeardown, rootBusy, tracker],
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
              onRetry={() => void readDashboard().catch(() => undefined)}
            />
            {progress && (
              <div className="mt-6">
                <ProgressPanel progress={progress} />
              </div>
            )}
          </>
        ) : (
          <RootFailure
            status={500}
            message={rootError ?? 'Unable to load PostgreSQL manager state'}
            onRetry={() => void readDashboard().catch(() => undefined)}
          />
        )}
        {pendingDecision?.kind === 'teardown' && (
          <TeardownDialog busy={false} onDecision={decideTeardown} />
        )}
      </ManagerShell>
    );
  }
  return (
    <ManagerShell badge={{ label: 'Action requested', tone: 'progress' }}>
      {!childState || childState.kind === 'preparing' ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900 shadow-sm">
          Preparing PostgreSQL operation…
        </div>
      ) : childState.kind === 'create-approval' ? (
        <CreateConnectionDialog context={childState.context} onDecision={decideCreate} />
      ) : childState.kind === 'delete-approval' ? (
        <DeleteConnectionDialog context={childState.context} onDecision={decideDelete} />
      ) : childState.kind === 'progress' ? (
        <ProgressPanel progress={childState.progress} />
      ) : (
        <ChildFailureDialog
          status={childState.status}
          message={childState.message}
          onClose={() => closeFailure(childState.status, childState.message)}
        />
      )}
    </ManagerShell>
  );
}
