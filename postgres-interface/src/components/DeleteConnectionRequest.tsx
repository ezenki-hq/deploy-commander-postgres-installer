import { useCallback, useEffect, useRef, useState } from 'react';
import type { RPCCaller, Wire } from '@ezenki/deploy-commander-installer-interface';
import DeleteConnectionDialog from './DeleteConnectionDialog';
import ManagerShell from './ManagerShell';
import StatusPanel from './StatusPanel';
import type { RunEventSource } from '../lib/runMonitor';
import { waitForRun } from '../lib/runMonitor';
import { deletePostgresConnection, type DeleteConnectionApprovalContext, type DeleteConnectionDecision } from '../lib/deletePostgresConnection';
import { PostgresRecoveryRequiredError, PostgresRequestError } from '../lib/postgresErrors';
import type { ParsedDeleteConnectionRequest } from '../lib/postgresDeleteRequest';

export interface DeleteConnectionRequestProps {
  caller: RPCCaller;
  events: RunEventSource;
  wire: Wire;
  currentManagerId: string;
  callingManagerId: string | null;
  metadata?: ParsedDeleteConnectionRequest;
  initialError?: string | null;
}
const EMPTY: ParsedDeleteConnectionRequest = { connectionId: null };
function closeError(wire: Wire, manager: string, status: number, message: string): void { wire.close({ manager, ok: false, error: { status, message } }); }
function errorResponse(error: unknown): { status: number; message: string } {
  if (error instanceof PostgresRequestError) {
    const messages: Record<number, string> = { 400: 'Invalid PostgreSQL connection deletion request', 404: 'PostgreSQL connection was not found', 409: 'PostgreSQL connection changed during deletion', 499: 'PostgreSQL connection deletion was cancelled' };
    return { status: error.status, message: messages[error.status] ?? 'Unable to delete the PostgreSQL connection' };
  }
  if (error instanceof Error) {
    const statuses: Record<string, number> = { 'A calling manager is required': 400, 'Invalid PostgreSQL connection deletion request': 400, 'PostgreSQL connection was not found': 404, 'PostgreSQL connection changed during deletion': 409, 'PostgreSQL connection deletion was cancelled': 499, 'PostgreSQL recovery is required': 503 };
    const status = statuses[error.message]; if (status !== undefined) return { status, message: error.message };
    if (error instanceof PostgresRecoveryRequiredError) return { status: 503, message: 'PostgreSQL recovery is required' };
  }
  return { status: 500, message: 'Unable to delete the PostgreSQL connection' };
}

export default function DeleteConnectionRequest({ caller, events, wire, currentManagerId, callingManagerId, metadata = EMPTY, initialError = null }: DeleteConnectionRequestProps) {
  const closedRef = useRef(false); const pendingRef = useRef<((decision: DeleteConnectionDecision) => void) | null>(null);
  const [approval, setApproval] = useState<DeleteConnectionApprovalContext | null>(null); const [busy, setBusy] = useState(false);
  const closeOnce = useCallback((response: { ok: boolean; result?: { connection: string }; status?: number; message?: string }) => {
    if (closedRef.current || !wire) return; closedRef.current = true;
    if (response.ok) wire.close({ manager: currentManagerId, ok: true, result: response.result }); else closeError(wire, currentManagerId, response.status ?? 500, response.message ?? 'Unable to delete the PostgreSQL connection');
  }, [currentManagerId, wire]);
  useEffect(() => {
    if (initialError) { closeOnce({ ok: false, ...errorResponse(new Error(initialError)) }); return undefined; }
    if (!caller || !events || !wire || !callingManagerId) { closeOnce({ ok: false, status: callingManagerId ? 503 : 400, message: callingManagerId ? 'PostgreSQL recovery is required' : 'A calling manager is required' }); return undefined; }
    let active = true; const controller = new AbortController();
    const requestApproval = (context: DeleteConnectionApprovalContext) => new Promise<DeleteConnectionDecision>((resolve) => { pendingRef.current = resolve; if (active) setApproval(context); });
    void deletePostgresConnection({ caller, events, requestApproval, waitForRun, signal: controller.signal }, { currentManagerId, callingManagerId, metadata })
      .then((result) => { if (active) closeOnce({ ok: true, result }); })
      .catch((error: unknown) => { if (error instanceof Error && error.name === 'AbortError') return; if (active) closeOnce({ ok: false, ...errorResponse(error) }); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; controller.abort(); pendingRef.current?.({ allowed: false }); pendingRef.current = null; };
  }, [caller, events, wire, currentManagerId, callingManagerId, metadata, initialError, closeOnce]);
  const progress = <ManagerShell badge={{ label: 'Deleting', tone: 'progress' }}><StatusPanel tone="progress" eyebrow="Logical database request" title={busy ? 'Deleting PostgreSQL connection' : 'Preparing PostgreSQL connection'} role="status">The manager is validating ownership and removing the connection safely.</StatusPanel></ManagerShell>;
  if (approval) return <>{progress}<DeleteConnectionDialog context={approval} busy={busy} onApprove={(connectionId) => { pendingRef.current?.({ allowed: true, connectionId }); pendingRef.current = null; setBusy(true); }} onReject={() => { pendingRef.current?.({ allowed: false }); pendingRef.current = null; setApproval(null); }} /></>;
  return progress;
}
