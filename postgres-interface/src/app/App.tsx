import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CreateConnectionDialog } from '../components/CreateConnectionDialog';
import { Dashboard } from '../components/Dashboard';
import { DeleteConnectionDialog } from '../components/DeleteConnectionDialog';
import { ProgressPanel } from '../components/ProgressPanel';
import { parseCreateRequest, parseDeleteRequest } from '../domain/requests';
import { PostgresRequestError, safeErrorMessage } from '../domain/errors';
import { createRunTracker, type RunProgress } from '../platform/runTracker';
import { createInterfaceClient, type InterfaceClient } from '../platform/interfaceClient';
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

export interface AppServices {
  createConnection: typeof createPostgresConnection;
  deleteConnection: typeof deletePostgresConnection;
  install: typeof installPostgres;
  teardown: typeof teardownPostgres;
}

type Props = { client?: InterfaceClient; services?: AppServices };
type Boot = { managerId: string; callingManagerId: string | null; metadata: unknown };

function statusOf(error: unknown): number {
  return error instanceof PostgresRequestError ? error.status : 500;
}

export default function App({ client: providedClient, services }: Props) {
  const client = useMemo(() => providedClient ?? createInterfaceClient(), [providedClient]);
  const tracker = useMemo(() => createRunTracker(client.caller, client.events), [client]);
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
  const [boot, setBoot] = useState<Boot | null>(null);
  const [bootError, setBootError] = useState<unknown>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
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
      tracker.dispose();
      client.dispose();
    };
  }, [client, tracker]);

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

  const lifecycleDeps = useMemo<LifecycleDeps>(
    () => ({
      caller: client.caller,
      runTracker: tracker,
      requestConfirmation: async (message) => window.confirm(message),
      onProgress,
      signal: new AbortController().signal,
    }),
    [client.caller, onProgress, tracker],
  );
  const runInstall = () => {
    setProgress({ phase: 'starting', runId: null });
    void appServices
      .install(lifecycleDeps)
      .then(() => setProgress(null))
      .catch(setBootError);
  };
  const runTeardown = () => {
    setProgress({ phase: 'starting', runId: null });
    void appServices
      .teardown(lifecycleDeps)
      .then(() => setProgress(null))
      .catch(setBootError);
  };

  if (bootError)
    return (
      <main>
        <h1>PostgreSQL Manager</h1>
        <p role="alert">{safeErrorMessage(bootError, 'Unable to load PostgreSQL manager')}</p>
      </main>
    );
  if (!boot)
    return (
      <main>
        <h1>PostgreSQL Manager</h1>
        <p>Loading…</p>
      </main>
    );
  if (boot.callingManagerId === null)
    return (
      <>
        <Dashboard
          caller={client.caller}
          onInstall={runInstall}
          onTeardown={runTeardown}
          busy={progress !== null}
        />
        {progress && <ProgressPanel progress={progress} />}
      </>
    );
  return (
    <main>
      <h1>PostgreSQL Manager</h1>
      {approval &&
        ('choices' in approval ? (
          <DeleteConnectionDialog context={approval} onDecision={resolveApproval} />
        ) : (
          <CreateConnectionDialog context={approval} onDecision={resolveApproval} />
        ))}
      {progress && <ProgressPanel progress={progress} />}
    </main>
  );
}
