import { useEffect, useRef, useState } from 'react';
import './App.css';
import { RPC, type Events } from '@ezenki/deploy-commander-installer-interface';
import ManagerDashboard, { type LifecycleAction } from './components/ManagerDashboard';
import ActionButton from './components/ActionButton';
import ConnectionRequest from './components/ConnectionRequest';
import DeleteConnectionRequest from './components/DeleteConnectionRequest';
import ManagerShell from './components/ManagerShell';
import StatusPanel from './components/StatusPanel';
import { createInterfaceClient, type AppClient } from './lib/interfaceClient';
import { createRunEventSource } from './lib/runMonitor';
import {
  parseConnectionRequest,
  type ParsedConnectionRequest,
} from './lib/postgresConnectionRequest';
import {
  parseDeleteConnectionRequest,
  type ParsedDeleteConnectionRequest,
} from './lib/postgresDeleteRequest';
import { listPostgresResources } from './lib/postgresResource';
import { readPostgresLifecycle, type PostgresLifecycle } from './lib/postgresRuns';
import { installPostgres, teardownPostgres } from './lib/lifecycleActions';

export type AppClientFactory = (onEvent: (event: Events.InterfaceEvent) => void) => AppClient;
export interface AppProps {
  createClient?: AppClientFactory;
}
type DashboardView = {
  kind: 'dashboard';
  manager: string;
  lifecycle: PostgresLifecycle;
  resource: RPC.ResourceItem | null;
  ambiguous: boolean;
  error: string | null;
};
type CreateConnectionView = {
  kind: 'create-connection';
  manager: string;
  metadata: ParsedConnectionRequest;
  error: string | null;
};
type DeleteConnectionView = {
  kind: 'delete-connection';
  manager: string;
  metadata: ParsedDeleteConnectionRequest;
  error: string | null;
};
type ChildView = CreateConnectionView | DeleteConnectionView;
type ErrorView = { kind: 'error'; message: string };
type View = DashboardView | ChildView | ErrorView;

const EMPTY_CONNECTION_REQUEST: ParsedConnectionRequest = { access: null, labels: {} };
const EMPTY_DELETE_REQUEST: ParsedDeleteConnectionRequest = { connectionId: null };

function childAction(value: unknown): 'create-connection' | 'delete-connection' | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const action = (value as { action?: unknown }).action;
  return action === 'create-connection' || action === 'delete-connection' ? action : null;
}

function managerId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
function safeError(error: unknown): string {
  return error instanceof Error && error.message === 'Unable to identify the PostgreSQL manager'
    ? error.message
    : 'Unable to load PostgreSQL manager state';
}
function productionClient(onEvent: (event: Events.InterfaceEvent) => void): AppClient {
  const events = createRunEventSource();
  const client = createInterfaceClient((event) => {
    events.publish(event);
    onEvent(event);
  });
  return { ...client, events };
}
const defaultClientFactory: AppClientFactory = productionClient;

export default function App({ createClient = defaultClientFactory }: AppProps) {
  const [view, setView] = useState<View | null>(null);
  const [action, setAction] = useState<LifecycleAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const clientRef = useRef<AppClient | null>(null);
  const clientFactoryRef = useRef<AppClientFactory | null>(null);
  const [client, setClient] = useState<AppClient | null>(null);
  const clientGeneration = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  // Connection requests are child workflows.  Their metadata and effect must
  // remain stable while the host refreshes dashboard state for run events.
  const connectionViewRef = useRef<ChildView | null>(null);

  useEffect(() => {
    const generation = ++clientGeneration.current;
    if (clientRef.current === null || clientFactoryRef.current !== createClient) {
      clientRef.current?.wire.end();
      clientRef.current = createClient((event) => {
        if (event.eventType === 'run-start' || event.eventType === 'run-update')
          setRefresh((value) => value + 1);
      });
      clientFactoryRef.current = createClient;
    }
    const stableClient = clientRef.current;
    connectionViewRef.current = null;
    const cleanupGeneration = generation;
    queueMicrotask(() => {
      if (clientGeneration.current === cleanupGeneration) setClient(stableClient);
    });
    return () => {
      queueMicrotask(() => {
        // The generation ref intentionally survives StrictMode's effect replay.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        if (clientGeneration.current !== cleanupGeneration) return;
        controllerRef.current?.abort();
        stableClient.wire.end();
        clientRef.current = null;
        setClient(null);
      });
    };
  }, [createClient]);

  useEffect(() => {
    if (!client) return undefined;
    if (connectionViewRef.current) {
      setView(connectionViewRef.current);
      return undefined;
    }
    let live = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    const boot = async (): Promise<View> => {
      const manager = managerId(await client.caller.getManager());
      if (!manager) throw new Error('Unable to identify the PostgreSQL manager');
      const metadata = await client.caller.getMetadata();
      const action = childAction(metadata);
      if (action) {
        if (action === 'delete-connection') {
          try {
            const next: DeleteConnectionView = {
              kind: 'delete-connection',
              manager,
              metadata: parseDeleteConnectionRequest(metadata),
              error: null,
            };
            connectionViewRef.current = next;
            return next;
          } catch {
            const next: DeleteConnectionView = {
              kind: 'delete-connection',
              manager,
              metadata: EMPTY_DELETE_REQUEST,
              error: 'Invalid PostgreSQL connection deletion request',
            };
            connectionViewRef.current = next;
            return next;
          }
        }
        try {
          const next: CreateConnectionView = {
            kind: 'create-connection',
            manager,
            metadata: parseConnectionRequest(metadata),
            error: null,
          };
          connectionViewRef.current = next;
          return next;
        } catch {
          const next: CreateConnectionView = {
            kind: 'create-connection',
            manager,
            metadata: EMPTY_CONNECTION_REQUEST,
            error: 'Invalid PostgreSQL connection request',
          };
          connectionViewRef.current = next;
          return next;
        }
      }
      const [{ lifecycle }, resources] = await Promise.all([
        readPostgresLifecycle(client.caller),
        listPostgresResources(client.caller),
      ]);
      const resource = resources.length === 1 ? resources[0] : null;
      return {
        kind: 'dashboard',
        manager,
        lifecycle,
        resource,
        ambiguous: resources.length > 1,
        error: null,
      };
    };
    void boot()
      .then((next) => {
        if (live) setView(next);
      })
      .catch((error: unknown) => {
        if (live) setView({ kind: 'error', message: safeError(error) });
      });
    return () => {
      live = false;
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [client, refresh]);

  const retry = () => {
    setActionError(null);
    setView(null);
    setRefresh((value) => value + 1);
  };
  if (!view)
    return (
      <ManagerShell badge={{ label: 'Loading', tone: 'progress' }}>
        <StatusPanel
          tone="progress"
          eyebrow="Manager startup"
          title="Loading manager state"
          role="status"
        >
          Checking PostgreSQL installation and recovery state.
        </StatusPanel>
      </ManagerShell>
    );
  if (view.kind === 'error')
    return (
      <ManagerShell badge={{ label: 'Unavailable', tone: 'danger' }}>
        <StatusPanel
          tone="danger"
          eyebrow="Manager startup"
          title="Manager startup requires attention"
          role="alert"
          actions={
            <ActionButton tone="secondary" onClick={retry}>
              Retry
            </ActionButton>
          }
        >
          {view.message}
        </StatusPanel>
      </ManagerShell>
    );
  if (!client) return null;
  if (view.kind === 'create-connection')
    return (
      <ConnectionRequest
        caller={client.caller}
        events={client.events}
        wire={client.wire}
        currentManagerId={view.manager}
        metadata={view.metadata}
        initialError={view.error}
      />
    );
  if (view.kind === 'delete-connection')
    return (
      <DeleteConnectionRequest
        caller={client.caller}
        events={client.events}
        wire={client.wire}
        currentManagerId={view.manager}
        metadata={view.metadata}
        initialError={view.error}
      />
    );
  const run = (
    kind: Exclude<LifecycleAction, null>,
    operation: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (action) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setAction(kind);
    setActionError(null);
    void operation(controller.signal)
      .then(retry)
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        setActionError(
          error instanceof Error && error.message.includes('failed')
            ? error.message
            : 'Unable to complete PostgreSQL lifecycle action',
        );
      })
      .finally(() => setAction(null));
  };
  return (
    <ManagerDashboard
      lifecycle={view.lifecycle}
      resource={view.resource}
      resourceAmbiguous={view.ambiguous}
      activeAction={action}
      error={actionError ?? view.error}
      onInstall={() =>
        run('install', (signal) =>
          installPostgres({ caller: client.caller, events: client.events, signal }),
        )
      }
      onTeardown={() =>
        run('teardown', (signal) =>
          teardownPostgres({ caller: client.caller, events: client.events, signal }),
        )
      }
      onRetry={retry}
    />
  );
}
