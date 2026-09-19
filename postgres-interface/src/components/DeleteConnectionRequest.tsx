import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { RPCCaller, Wire } from '@ezenki/deploy-commander-installer-interface';
import DeleteConnectionDialog from './DeleteConnectionDialog';
import ManagerShell from './ManagerShell';
import StatusPanel from './StatusPanel';
import type { RunEventSource } from '../lib/runMonitor';
import { waitForRun } from '../lib/runMonitor';
import {
  deletePostgresConnection,
  type DeleteConnectionApprovalContext,
  type DeleteConnectionDecision,
} from '../lib/deletePostgresConnection';
import { PostgresRecoveryRequiredError, PostgresRequestError } from '../lib/postgresErrors';
import type { ParsedDeleteConnectionRequest } from '../lib/postgresDeleteRequest';
import { actionGateReducer, initialActionGate, type ActionGateFailure } from '../lib/actionGate';

export interface DeleteConnectionRequestProps {
  caller: RPCCaller;
  events: RunEventSource;
  wire: Wire;
  currentManagerId: string;
  metadata?: ParsedDeleteConnectionRequest;
  initialError?: string | null;
}
const EMPTY: ParsedDeleteConnectionRequest = { connectionId: null };
function closeError(wire: Wire, manager: string, status: number, message: string): void {
  wire.close({ manager, ok: false, error: { status, message } });
}
function errorResponse(error: unknown): { status: number; message: string } {
  if (error instanceof PostgresRequestError) {
    const messages: Record<number, string> = {
      400: 'Invalid PostgreSQL connection deletion request',
      404: 'PostgreSQL connection was not found',
      409: 'PostgreSQL connection changed during deletion',
      499: 'PostgreSQL connection deletion was cancelled',
    };
    return {
      status: error.status,
      message: messages[error.status] ?? 'Unable to delete the PostgreSQL connection',
    };
  }
  if (
    error instanceof PostgresRecoveryRequiredError ||
    (error instanceof Error && error.message === 'PostgreSQL recovery is required')
  )
    return { status: 503, message: 'PostgreSQL recovery is required' };
  if (error instanceof Error) {
    const known: Record<string, { status: number; message: string }> = {
      'A calling manager is required': { status: 400, message: 'A calling manager is required' },
      'Invalid PostgreSQL connection deletion request': {
        status: 400,
        message: 'Invalid PostgreSQL connection deletion request',
      },
      'PostgreSQL connection was not found': {
        status: 404,
        message: 'PostgreSQL connection was not found',
      },
      'PostgreSQL connection changed during deletion': {
        status: 409,
        message: 'PostgreSQL connection changed during deletion',
      },
      'PostgreSQL connection deletion was cancelled': {
        status: 499,
        message: 'PostgreSQL connection deletion was cancelled',
      },
    };
    if (known[error.message]) return known[error.message];
  }
  return { status: 500, message: 'Unable to delete the PostgreSQL connection' };
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

export default function DeleteConnectionRequest({
  caller,
  events,
  wire,
  currentManagerId,
  metadata = EMPTY,
  initialError = null,
}: DeleteConnectionRequestProps) {
  const closedRef = useRef(false);
  const pendingRef = useRef<((decision: DeleteConnectionDecision) => void) | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const phaseRef = useRef<'preparing' | 'waiting' | 'approved' | 'rejected'>('preparing');
  const [attempt, setAttempt] = useState(0);
  const initialFailure = initialError ? gateFailure(new Error(initialError)) : null;
  const [gate, dispatch] = useReducer(
    actionGateReducer<DeleteConnectionApprovalContext>,
    initialActionGate<DeleteConnectionApprovalContext>(initialFailure),
  );
  const closeOnce = useCallback(
    (response: {
      ok: boolean;
      result?: { connection: string };
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
          response.message ?? 'Unable to delete the PostgreSQL connection',
        );
    },
    [currentManagerId, wire],
  );
  useEffect(() => {
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
        const requestApproval = (context: DeleteConnectionApprovalContext) =>
          new Promise<DeleteConnectionDecision>((resolve) => {
            pendingRef.current = resolve;
            phaseRef.current = 'waiting';
            if (active) dispatch({ type: 'prepared', callerId: callingManagerId, context });
          });
        const result = await deletePostgresConnection(
          { caller, events, requestApproval, waitForRun, signal: controller.signal },
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
        closeOnce({ ok: false, ...errorResponse(error) });
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
  }, [attempt, caller, events, wire, currentManagerId, metadata, initialError, closeOnce]);
  const reject = () => {
    if (gate.kind === 'executing' || closedRef.current) return;
    phaseRef.current = 'rejected';
    pendingRef.current?.({ allowed: false });
    pendingRef.current = null;
    dispatch({ type: 'close' });
    controllerRef.current?.abort();
    closeOnce({ ok: false, status: 499, message: 'PostgreSQL connection deletion was cancelled' });
  };
  const retry = () => {
    if (gate.kind !== 'blocked' || !gate.failure.retryable) return;
    phaseRef.current = 'preparing';
    dispatch({ type: 'retry' });
    setAttempt((value) => value + 1);
  };
  if (gate.kind === 'closed') return null;
  const progressTitle =
    gate.kind === 'executing'
      ? 'Deleting PostgreSQL connection'
      : 'Preparing PostgreSQL connection';
  return (
    <>
      <ManagerShell
        badge={{ label: gate.kind === 'executing' ? 'Deleting' : 'Preparing', tone: 'progress' }}
      >
        <StatusPanel
          tone="progress"
          eyebrow="Logical database request"
          title={progressTitle}
          role="status"
        >
          The manager is validating ownership and preparing the destructive operation.
        </StatusPanel>
      </ManagerShell>
      <DeleteConnectionDialog
        gate={gate}
        onApprove={(connectionId) => {
          if (gate.kind !== 'ready') return;
          phaseRef.current = 'approved';
          dispatch({ type: 'approve' });
          pendingRef.current?.({ allowed: true, connectionId });
          pendingRef.current = null;
        }}
        onReject={reject}
        onRetry={retry}
      />
    </>
  );
}
