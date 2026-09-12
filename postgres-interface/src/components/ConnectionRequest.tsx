import { useCallback, useEffect, useRef, useState } from 'react';
import type { RPC, RPCCaller, Wire } from '@ezenki/deploy-commander-installer-interface';
import PermissionDialog from './PermissionDialog';
import ManagerShell from './ManagerShell';
import StatusPanel from './StatusPanel';
import { generateConnectionCredentials } from '../lib/credentials';
import { parsePlatformConnection } from '../lib/postgresContracts';
import { createPostgresConnection, type PermissionDecision } from '../lib/createPostgresConnection';
import type { ReadyPrimaryState } from '../lib/primaryState';
import type { RunEventSource } from '../lib/runMonitor';
import { waitForRun } from '../lib/runMonitor';
import { OperationBusyError, PostgresRecoveryRequiredError } from '../lib/postgresErrors';

export interface ConnectionRequestProps {
  caller?: RPCCaller;
  events?: RunEventSource;
  wire?: Wire;
  currentManagerId: string;
  callingManagerId: string | null;
  resource: RPC.ResourceItem | null;
  primary: ReadyPrimaryState | null;
  initialError?: string | null;
  initialResult?: RPC.CreateConnection | null;
  storage?: Storage;
}

function closeError(wire: Wire, manager: string, status: number, message: string): void {
  wire.close({ manager, ok: false, error: { status, message } });
}

function errorResponse(error: unknown): { status: number; message: string } {
  if (error instanceof OperationBusyError || (error instanceof Error && error.message === 'A PostgreSQL operation is already in progress')) {
    return { status: 409, message: 'A PostgreSQL operation is already in progress' };
  }
  if (error instanceof Error && error.message === 'A calling manager is required') {
    return { status: 400, message: 'A calling manager is required' };
  }
  if (error instanceof Error && error.message === 'Database access was cancelled') {
    return { status: 499, message: 'Database access was cancelled' };
  }
  if (error instanceof PostgresRecoveryRequiredError
    || error instanceof Error && error.message === 'PostgreSQL recovery is required') {
    return { status: 503, message: 'PostgreSQL recovery is required' };
  }
  return { status: 500, message: 'Unable to create the PostgreSQL connection' };
}

export default function ConnectionRequest({
  caller,
  events,
  wire,
  currentManagerId,
  callingManagerId,
  resource,
  primary,
  initialError = null,
  initialResult = null,
  storage,
}: ConnectionRequestProps) {
  const closedRef = useRef(false);
  const pendingRef = useRef<((decision: PermissionDecision) => void) | null>(null);
  const [prompt, setPrompt] = useState(false);
  const [busy, setBusy] = useState(Boolean(initialResult));

  const closeOnce = useCallback((response: { ok: boolean; result?: RPC.CreateConnection; status?: number; message?: string }) => {
    if (closedRef.current || !wire) return;
    closedRef.current = true;
    if (response.ok) wire.close({ manager: currentManagerId, ok: true, result: response.result });
    else closeError(wire, currentManagerId, response.status ?? 500, response.message ?? 'Unable to create the PostgreSQL connection');
  }, [currentManagerId, wire]);

  useEffect(() => {
    if (initialResult) {
      closeOnce({ ok: true, result: initialResult });
      return undefined;
    }
    if (initialError) {
      const mapped = errorResponse(new Error(initialError));
      closeOnce({ ok: false, ...mapped });
      return undefined;
    }
    if (!caller || !events || !wire || !callingManagerId || !resource || !primary) {
      closeOnce({ ok: false, status: callingManagerId ? 503 : 400, message: callingManagerId ? 'PostgreSQL recovery is required' : 'A calling manager is required' });
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    const requestPermission = () => new Promise<PermissionDecision>((resolve) => {
      pendingRef.current = resolve;
      if (active) setPrompt(true);
    });
    const run = async () => {
      let details: unknown;
      try {
        details = await caller.getResource(resource.id);
      } catch {
        throw new PostgresRecoveryRequiredError();
      }
      if (typeof details !== 'object' || details === null || typeof (details as { config?: unknown }).config !== 'object' || (details as { config?: unknown }).config === null) {
        throw new PostgresRecoveryRequiredError();
      }
      const config = (details as { config: { platform_connection?: unknown } }).config;
      let platform;
      try {
        platform = parsePlatformConnection(config.platform_connection);
      } catch {
        throw new PostgresRecoveryRequiredError();
      }
      const selectedStorage = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
      if (!selectedStorage) throw new Error('Unable to create the PostgreSQL connection');
      return createPostgresConnection({
      caller,
      events,
      storage: selectedStorage,
      requestPermission,
      generateCredentials: () => generateConnectionCredentials(),
      waitForRun,
      signal: controller.signal,
    }, {
      currentManagerId,
      callingManagerId,
      resource,
      platform,
      primary,
      });
    };
    void run().then((result) => {
      if (active) closeOnce({ ok: true, result });
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (active) closeOnce({ ok: false, ...errorResponse(error) });
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
      controller.abort();
      pendingRef.current?.({ allowed: false, remember: false });
      pendingRef.current = null;
    };
  }, [caller, events, wire, currentManagerId, callingManagerId, resource, primary, initialError, initialResult, storage, closeOnce]);

  const progress = <ManagerShell badge={{ label: 'Connecting', tone: 'progress' }}>
    <StatusPanel
      tone="progress"
      eyebrow="Logical database request"
      title={busy ? 'Creating PostgreSQL connection' : 'Preparing PostgreSQL connection'}
      role="status"
    >
      The manager is validating the installation and preparing isolated database credentials.
    </StatusPanel>
  </ManagerShell>;

  if (prompt) {
    return <>
      {progress}
      <PermissionDialog
        callerId={callingManagerId ?? ''}
        busy={busy}
        onAllow={(remember) => {
          pendingRef.current?.({ allowed: true, remember });
          pendingRef.current = null;
          setPrompt(false);
          setBusy(true);
        }}
        onCancel={() => {
          pendingRef.current?.({ allowed: false, remember: false });
          pendingRef.current = null;
          setPrompt(false);
        }}
      />
    </>;
  }
  return progress;
}
