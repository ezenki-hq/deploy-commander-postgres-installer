import { useCallback, useEffect, useRef, useState } from 'react';
import type { RPC, RPCCaller, Wire } from '@ezenki/deploy-commander-installer-interface';
import ConnectionApprovalDialog from './ConnectionApprovalDialog';
import ManagerShell from './ManagerShell';
import StatusPanel from './StatusPanel';
import { generateAdminCredentials, generateLoginCredentials } from '../lib/credentials';
import {
  createPostgresConnection,
  type ApprovalContext,
  type ApprovalDecision,
} from '../lib/createPostgresConnection';
import type { RunEventSource } from '../lib/runMonitor';
import { waitForRun } from '../lib/runMonitor';
import {
  OperationBusyError,
  PostgresRecoveryRequiredError,
  PostgresRequestError,
} from '../lib/postgresErrors';
import type { ParsedConnectionRequest } from '../lib/postgresConnectionRequest';

const EMPTY_METADATA: ParsedConnectionRequest = { access: null, labels: {} };

export interface ConnectionRequestProps {
  caller: RPCCaller;
  events: RunEventSource;
  wire: Wire;
  currentManagerId: string;
  callingManagerId: string | null;
  /** Parsed child-interface metadata. Omitted values delegate configuration to the user. */
  metadata?: ParsedConnectionRequest;
  /** @deprecated ignored; retained for host compatibility during cutover. */
  resource?: unknown;
  /** @deprecated ignored; retained for host compatibility during cutover. */
  primary?: unknown;
  initialError?: string | null;
  initialResult?: RPC.CreateConnection | null;
}

function closeError(wire: Wire, manager: string, status: number, message: string): void {
  wire.close({ manager, ok: false, error: { status, message } });
}

function requestErrorResponse(error: PostgresRequestError): { status: number; message: string } {
  const messages: Record<number, string> = {
    400: 'Invalid PostgreSQL connection request',
    404: 'Requested PostgreSQL database was not found',
    409: 'A PostgreSQL connection request conflicts with existing state',
    499: 'Database access was cancelled',
  };
  return { status: error.status, message: messages[error.status] };
}

function errorResponse(error: unknown): { status: number; message: string } {
  if (error instanceof PostgresRequestError) return requestErrorResponse(error);
  if (
    error instanceof OperationBusyError ||
    (error instanceof Error && error.message === 'A PostgreSQL operation is already in progress')
  ) {
    return { status: 409, message: 'A PostgreSQL operation is already in progress' };
  }
  if (error instanceof Error && error.message === 'A calling manager is required') {
    return { status: 400, message: 'A calling manager is required' };
  }
  if (error instanceof Error && error.message === 'Invalid PostgreSQL connection request') {
    return { status: 400, message: 'Invalid PostgreSQL connection request' };
  }
  if (error instanceof Error && error.message === 'Database access was cancelled') {
    return { status: 499, message: 'Database access was cancelled' };
  }
  if (
    error instanceof PostgresRecoveryRequiredError ||
    (error instanceof Error && error.message === 'PostgreSQL recovery is required')
  ) {
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
  metadata = EMPTY_METADATA,
  initialError = null,
  initialResult = null,
}: ConnectionRequestProps) {
  const closedRef = useRef(false);
  const pendingRef = useRef<((decision: ApprovalDecision) => void) | null>(null);
  const [approval, setApproval] = useState<ApprovalContext | null>(null);
  const [busy, setBusy] = useState(Boolean(initialResult));

  const closeOnce = useCallback(
    (response: {
      ok: boolean;
      result?: RPC.CreateConnection;
      status?: number;
      message?: string;
    }) => {
      if (closedRef.current || !wire) return;
      closedRef.current = true;
      if (response.ok) wire.close({ manager: currentManagerId, ok: true, result: response.result });
      else
        closeError(
          wire,
          currentManagerId,
          response.status ?? 500,
          response.message ?? 'Unable to create the PostgreSQL connection',
        );
    },
    [currentManagerId, wire],
  );

  useEffect(() => {
    if (initialResult) {
      closeOnce({ ok: true, result: initialResult });
      return undefined;
    }
    if (initialError) {
      closeOnce({ ok: false, ...errorResponse(new Error(initialError)) });
      return undefined;
    }
    if (!caller || !events || !wire || !callingManagerId) {
      closeOnce({
        ok: false,
        status: callingManagerId ? 503 : 400,
        message: callingManagerId
          ? 'PostgreSQL recovery is required'
          : 'A calling manager is required',
      });
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    const requestApproval = (context: ApprovalContext) =>
      new Promise<ApprovalDecision>((resolve) => {
        pendingRef.current = resolve;
        if (active) setApproval(context);
      });
    const run = async () =>
      createPostgresConnection(
        {
          caller,
          events,
          requestApproval,
          generateAdminCredentials,
          generateCredentials: generateLoginCredentials,
          waitForRun,
          signal: controller.signal,
        },
        { currentManagerId, callingManagerId, metadata },
      );
    void run()
      .then((result) => {
        if (active) closeOnce({ ok: true, result });
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        if (active) closeOnce({ ok: false, ...errorResponse(error) });
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      controller.abort();
      pendingRef.current?.({ allowed: false });
      pendingRef.current = null;
    };
  }, [
    caller,
    events,
    wire,
    currentManagerId,
    callingManagerId,
    metadata,
    initialError,
    initialResult,
    closeOnce,
  ]);

  const progress = (
    <ManagerShell badge={{ label: 'Connecting', tone: 'progress' }}>
      <StatusPanel
        tone="progress"
        eyebrow="Logical database request"
        title={busy ? 'Creating PostgreSQL connection' : 'Preparing PostgreSQL connection'}
        role="status"
      >
        The manager is validating the installation and preparing isolated database credentials.
      </StatusPanel>
    </ManagerShell>
  );

  if (approval) {
    return (
      <>
        {progress}
        <ConnectionApprovalDialog
          context={approval}
          busy={busy}
          onApprove={(access) => {
            pendingRef.current?.({ allowed: true, access });
            pendingRef.current = null;
            setApproval(null);
            setBusy(true);
          }}
          onReject={() => {
            pendingRef.current?.({ allowed: false });
            pendingRef.current = null;
            setApproval(null);
          }}
        />
      </>
    );
  }
  return progress;
}
