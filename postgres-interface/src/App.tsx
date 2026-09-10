import { useEffect, useRef, useState } from 'react';
import './App.css';
import { RPC, type Events } from '@ezenki/deploy-commander-installer-interface';
import ManagerDashboard, { type LifecycleAction } from './components/ManagerDashboard';
import ActionButton from './components/ActionButton';
import ConnectionRequest from './components/ConnectionRequest';
import ManagerShell from './components/ManagerShell';
import StatusPanel from './components/StatusPanel';
import { createInterfaceClient } from './lib/interfaceClient';
import { createRunEventSource } from './lib/runMonitor';
import { findPrimaryResource, readPrimaryState, type PrimaryState } from './lib/primaryState';
import { isCreateConnectionMetadata } from './lib/postgresContracts';
import { recoverConnectionOnBoot, type AppClient } from './lib/appRecovery';
import type { ReadyPrimaryState } from './lib/primaryState';
import { installPostgres, recoverInstallationOnBoot, recoverTeardownOnBoot, teardownPostgres } from './lib/installationLifecycle';
import { clearPermission, isPermissionRemembered } from './lib/permissionPreference';
import {
  initializeManagerDatabase,
  ManagerDatabaseInitializationError,
} from './lib/managerDatabase';

export type AppClientFactory = (onEvent: (event: Events.InterfaceEvent) => void) => AppClient;

export interface AppProps {
  /** Injectable only to make the wire lifecycle deterministic in tests. */
  createClient?: AppClientFactory;
}

type BootView =
  | { kind: 'dashboard'; resource: RPC.ResourceItem | null; primary: PrimaryState | null; ambiguous: boolean; error: string | null }
  | { kind: 'connection'; resource: RPC.ResourceItem | null; primary: ReadyPrimaryState | null; callerId: string | null; error: string | null; result: RPC.CreateConnection | null }
  | { kind: 'error'; message: string };

function managerId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function bootErrorMessage(error: unknown): string {
  if (error instanceof ManagerDatabaseInitializationError) return error.message;
  if (error instanceof Error && [
    'Unable to identify the PostgreSQL manager',
    'PostgreSQL recovery is required',
    'PostgreSQL lifecycle recovery is required',
  ].includes(error.message)) {
    return error.message;
  }
  return 'Unable to load PostgreSQL manager state';
}

function bootErrorTitle(message: string): string {
  return message === 'Unable to initialize PostgreSQL manager storage'
    ? 'Manager storage is unavailable'
    : 'Manager startup requires attention';
}

function callerId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isReadyPrimary(value: PrimaryState | null, resource: RPC.ResourceItem | null): value is ReadyPrimaryState {
  return value !== null && value.phase === 'ready'
    && typeof value.resourceId === 'string'
    && resource !== null && value.resourceId === resource.id;
}

function productionClient(onEvent: (event: Events.InterfaceEvent) => void): AppClient {
  const events = createRunEventSource();
  const interfaceClient = createInterfaceClient((event) => {
    events.publish(event);
    onEvent(event);
  });
  return { ...interfaceClient, events };
}

function stateError(resource: RPC.ResourceItem | null, primary: PrimaryState | null): string | null {
  if (resource === null && primary === null) return null;
  if (resource !== null && primary === null) return null; // legacy install: teardown/reinstall
  if (resource !== null && isReadyPrimary(primary, resource)) return null;
  if (resource !== null && primary?.phase === 'teardown-failed' && primary.resourceId === resource.id) return null;
  return 'PostgreSQL recovery is required';
}

/** Count exact resources independently of primary-state contents. */
async function countPrimaryResources(caller: ReturnType<typeof RPC.SetupRPCCaller>): Promise<number> {
  let offset = 0;
  let total = 0;
  while (true) {
    const page = await caller.getMyResources('postgres', false, 50, offset);
    if (!page || !Array.isArray(page.items) || typeof page.limit !== 'number' || typeof page.total !== 'number') {
      throw new Error('PostgreSQL resource lookup failed');
    }
    total += page.items.filter((item) => item.external === false && item.type === 'postgres' && item.name === 'postgres').length;
    if (page.items.length === 0 || offset + page.items.length >= page.total) return total;
    if (page.limit <= 0) throw new Error('PostgreSQL resource lookup failed');
    offset += page.limit;
  }
}

/** The root component keeps one wire/caller pair for its complete lifetime. */
interface AppPresentation {
  factory: AppClientFactory;
  client: AppClient;
  manager: string;
  view: BootView;
}

export default function App({ createClient = productionClient }: AppProps) {
  const [presentation, setPresentation] = useState<AppPresentation | null>(null);
  const [activeAction, setActiveAction] = useState<LifecycleAction>(null);
  const [failedAction, setFailedAction] = useState<Exclude<LifecycleAction, null> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const clientRef = useRef<AppClient | null>(null);
  const actionControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const client = createClient(() => undefined);
    clientRef.current = client;
    return () => {
      actionControllerRef.current?.abort();
      client.wire.end();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [createClient]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return undefined;
    let active = true;
    const controller = new AbortController();

    const boot = async () => {
      const currentManager = managerId(await client.caller.getManager());
      if (!currentManager) throw new Error('Unable to identify the PostgreSQL manager');
      const metadata: unknown = await client.caller.getMetadata();
      const connectionMode = isCreateConnectionMetadata(metadata);

      if (connectionMode) {
        const callingManager = callerId(
          await client.caller.getCallingManager().catch(() => null),
        );
        if (!callingManager) {
          return {
            currentManager, mode: 'connection' as const,
            resource: null, primary: null, callerId: null,
            error: 'A calling manager is required', result: null,
          };
        }
        try {
          await initializeManagerDatabase(client.caller);
        } catch {
          return {
            currentManager, mode: 'connection' as const,
            resource: null, primary: null, callerId: callingManager,
            error: 'PostgreSQL recovery is required', result: null,
          };
        }

        try {
          // Reconcile persisted operations before exposing a connection request.
          const recovery = await recoverConnectionOnBoot(client, controller.signal, callingManager);
          const resource = await findPrimaryResource(client.caller);
          const primary = await readPrimaryState(client.caller);
          const resourceCount = await countPrimaryResources(client.caller);
          const problem = resourceCount > 1 ? 'PostgreSQL resource state is ambiguous; teardown and reinstall are required.' : stateError(resource, primary);
          return {
            currentManager, mode: 'connection' as const, resource,
            primary: isReadyPrimary(primary, resource) ? primary : null,
            callerId: callingManager,
            error: resourceCount > 1 ? 'PostgreSQL recovery is required' : problem ?? (recovery?.kind === 'busy' ? 'A PostgreSQL operation is already in progress' : null),
            result: recovery?.kind === 'connection' ? recovery.value : null,
          };
        } catch {
          return {
            currentManager, mode: 'connection' as const, resource: null, primary: null,
            callerId: callingManager,
            error: 'PostgreSQL recovery is required', result: null,
          };
        }
      }

      await initializeManagerDatabase(client.caller);

      // Reconcile installation and teardown state before rendering controls.
      const installRecovery = await recoverInstallationOnBoot({ caller: client.caller, events: client.events, signal: controller.signal });
      const teardownRecovery = await recoverTeardownOnBoot({ caller: client.caller, events: client.events, signal: controller.signal, managerId: currentManager, storage: typeof window !== 'undefined' ? window.localStorage : undefined });
      const connectionRecovery = await recoverConnectionOnBoot(client, controller.signal);
      const resource = await findPrimaryResource(client.caller);
      const primary = await readPrimaryState(client.caller);
      const resourceCount = await countPrimaryResources(client.caller);
      return {
        currentManager,
        mode: 'dashboard' as const,
        resource,
        primary,
        ambiguous: resourceCount > 1,
        error: resourceCount > 1 ? null
          : installRecovery?.kind === 'busy' || teardownRecovery?.kind === 'busy' || connectionRecovery?.kind === 'busy'
            ? 'A PostgreSQL operation is already in progress'
            : stateError(resource, primary),
      };
    };

    void boot().then((next) => {
      if (!active) return;
      const view: BootView = next.mode === 'connection'
        ? {
            kind: 'connection', resource: next.resource, primary: next.primary,
            callerId: next.callerId, error: next.error, result: next.result,
          }
        : {
            kind: 'dashboard', resource: next.resource, primary: next.primary,
            ambiguous: next.ambiguous, error: next.error,
          };
      setPresentation({
        factory: createClient,
        client,
        manager: next.currentManager,
        view,
      });
    }).catch((error: unknown) => {
      if (!active) return;
      setPresentation({
        factory: createClient,
        client,
        manager: '',
        view: {
          kind: 'error',
          message: bootErrorMessage(error),
        },
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [createClient, refreshKey]);

  const requestRefresh = () => {
    setActionError(null);
    setFailedAction(null);
    setPresentation(null);
    setRefreshKey((value) => value + 1);
  };

  const current = presentation?.factory === createClient ? presentation : null;
  if (!current) {
    return <ManagerShell badge={{ label: 'Loading', tone: 'progress' }}>
      <StatusPanel
        tone="progress"
        eyebrow="Manager startup"
        title="Loading manager state"
        role="status"
      >
        Checking PostgreSQL installation and recovery state.
      </StatusPanel>
    </ManagerShell>;
  }
  const { client, manager, view } = current;
  if (view.kind === 'error') {
    return <ManagerShell badge={{ label: 'Unavailable', tone: 'danger' }}>
      <StatusPanel
        tone="danger"
        eyebrow="Manager startup"
        title={bootErrorTitle(view.message)}
        role="alert"
        actions={<ActionButton tone="secondary" onClick={requestRefresh}>Retry</ActionButton>}
      >
        {view.message}
      </StatusPanel>
    </ManagerShell>;
  }
  if (view.kind === 'connection') {
    return <ConnectionRequest caller={client.caller} events={client.events} wire={client.wire} currentManagerId={manager} callingManagerId={view.callerId} resource={view.resource} primary={view.primary} initialError={view.error} initialResult={view.result} />;
  }
  const appClient = client;
  const storage = typeof window !== 'undefined' ? window.localStorage : undefined;
  const permissionRemembered = Boolean(view.resource && storage && isPermissionRemembered(storage, manager, view.resource.id));
  const runAction = async (
    kind: Exclude<LifecycleAction, null>,
    action: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (activeAction !== null) return;
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setActiveAction(kind);
    setActionError(null);
    setFailedAction(null);
    try {
      await action(controller.signal);
      requestRefresh();
    }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      setFailedAction(
        error instanceof Error && (
          (kind === 'install' && error.message === 'PostgreSQL installation failed')
          || (kind === 'teardown' && error.message === 'PostgreSQL teardown failed')
        ) ? kind : null,
      );
      setActionError(error instanceof Error && error.message.includes('recovery') ? 'PostgreSQL recovery is required' : 'Unable to complete PostgreSQL lifecycle action');
    }
    finally {
      if (actionControllerRef.current === controller) {
        actionControllerRef.current = null;
      }
      setActiveAction(null);
    }
  };
  return <ManagerDashboard
    resource={view.resource}
    primary={view.primary}
    activeAction={activeAction}
    error={actionError ?? view.error}
    permissionRemembered={permissionRemembered}
    resourceAmbiguous={view.ambiguous}
    failedAction={failedAction ?? undefined}
    onInstall={() => {
      void runAction('install', (signal) => installPostgres({
        caller: appClient.caller,
        events: appClient.events,
        signal,
      }));
    }}
    onTeardown={() => {
      const resource = view.resource;
      if (!resource) return;
      void runAction('teardown', (signal) => teardownPostgres({
        caller: appClient.caller,
        events: appClient.events,
        signal,
        managerId: manager || undefined,
        storage,
      }, resource));
    }}
    onRetry={requestRefresh}
    onResetPermission={() => {
      if (view.resource && storage) {
        clearPermission(storage, manager, view.resource.id);
        requestRefresh();
      }
    }}
  />;
}
