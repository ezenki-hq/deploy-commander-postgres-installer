import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
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
import {
  actionGateReducer,
  initialActionGate,
  type ActionGateFailure,
  type ActionGateState,
} from '../lib/actionGate';

const EMPTY_METADATA: ParsedConnectionRequest = { access: null, labels: {} };

export interface ConnectionRequestProps {
  caller: RPCCaller;
  events: RunEventSource;
  wire: Wire;
  currentManagerId: string;
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

function managerId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function gateFailure(error: unknown): ActionGateFailure {
  const response = errorResponse(error);
  return {
    ...response,
    retryable: response.status === 409 || response.status === 500 || response.status === 503,
  };
}

export default function ConnectionRequest({
  caller,
  events,
  wire,
  currentManagerId,
  metadata = EMPTY_METADATA,
  initialError = null,
  initialResult = null,
}: ConnectionRequestProps) {
  const closedRef = useRef(false);
  const pendingRef = useRef<((decision: ApprovalDecision) => void) | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const phaseRef = useRef<'preparing' | 'waiting' | 'approved' | 'rejected'>('preparing');
  const [attempt, setAttempt] = useState(0);
  const initialFailure = initialError ? gateFailure(new Error(initialError)) : null;
  const [gate, dispatch] = useReducer(
    actionGateReducer<ApprovalContext>,
    initialActionGate<ApprovalContext>(initialFailure),
  );

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
    if (initialError || !caller || !events || !wire) return undefined;

    let active = true;
    const controller = new AbortController();
    controllerRef.current = controller;

    const run = async () => {
      try {
        let callingManagerId: string | null = null;
        try {
          callingManagerId = managerId(await caller.getCallingManager());
        } catch {
          callingManagerId = null;
        }
        if (!active) return;
        if (!callingManagerId) {
          dispatch({
            type: 'blocked',
            failure: { status: 400, message: 'A calling manager is required', retryable: false },
          });
          return;
        }
        dispatch({ type: 'identified', callerId: callingManagerId });
        const requestApproval = (context: ApprovalContext) =>
          new Promise<ApprovalDecision>((resolve) => {
            pendingRef.current = resolve;
            phaseRef.current = 'waiting';
            if (active) dispatch({ type: 'prepared', callerId: callingManagerId, context });
          });
        const result = await createPostgresConnection(
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
        if (active) {
          dispatch({ type: 'complete' });
          closeOnce({ ok: true, result });
        }
      } catch (error: unknown) {
        if (!active || (error instanceof Error && error.name === 'AbortError')) return;
        if (phaseRef.current === 'preparing') {
          dispatch({ type: 'blocked', failure: gateFailure(error) });
          return;
        }
        if (phaseRef.current === 'rejected') return;
        dispatch({ type: 'complete' });
        const response = errorResponse(error);
        closeOnce({ ok: false, ...response });
      }
    };
    void run();

    return () => {
      active = false;
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
      pendingRef.current?.({ allowed: false });
      pendingRef.current = null;
    };
  }, [attempt, caller, events, wire, currentManagerId, metadata, initialError, initialResult, closeOnce]);

  const reject = () => {
    if (gate.kind === 'executing' || closedRef.current) return;
    phaseRef.current = 'rejected';
    const response =
      gate.kind === 'blocked'
        ? { status: gate.failure.status, message: gate.failure.message }
        : { status: 499, message: 'Database access was cancelled' };
    pendingRef.current?.({ allowed: false });
    pendingRef.current = null;
    dispatch({ type: 'close' });
    controllerRef.current?.abort();
    closeOnce({ ok: false, ...response });
  };

  const retry = () => {
    if (gate.kind !== 'blocked' || !gate.failure.retryable) return;
    phaseRef.current = 'preparing';
    dispatch({ type: 'retry' });
    setAttempt((value) => value + 1);
  };

  if (gate.kind === 'closed') return null;

  const progressTitle = gate.kind === 'executing' ? 'Creating PostgreSQL connection' : 'Preparing PostgreSQL connection';
  return (
    <>
      <ManagerShell badge={{ label: gate.kind === 'executing' ? 'Connecting' : 'Preparing', tone: 'progress' }}>
        <StatusPanel
          tone="progress"
          eyebrow="Logical database request"
          title={progressTitle}
          role="status"
        >
          The manager is validating the installation and preparing isolated database credentials.
        </StatusPanel>
      </ManagerShell>
      <ConnectionApprovalDialog
        gate={gate}
        request={metadata}
        onApprove={(access) => {
          if (gate.kind !== 'ready') return;
          phaseRef.current = 'approved';
          dispatch({ type: 'approve' });
          pendingRef.current?.({ allowed: true, access });
          pendingRef.current = null;
        }}
        onReject={reject}
        onRetry={retry}
      />
    </>
  );
}
