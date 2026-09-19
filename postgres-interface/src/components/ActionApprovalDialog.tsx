import type { ReactNode } from 'react';
import ActionButton from './ActionButton';
import useDialogFocus from './useDialogFocus';

export interface ActionApprovalDialogProps {
  title: string;
  callerId: string | null;
  phase: 'preparing' | 'ready' | 'blocked' | 'executing';
  status?: string;
  error?: string;
  children?: ReactNode;
  primaryAction?: ReactNode;
  retryAction?: ReactNode;
  rejectLabel?: string;
  onReject: () => void;
}

export default function ActionApprovalDialog({
  title,
  callerId,
  phase,
  status,
  error,
  children,
  primaryAction,
  retryAction,
  rejectLabel = 'Reject',
  onReject,
}: ActionApprovalDialogProps) {
  const executing = phase === 'executing';
  const dialogRef = useDialogFocus<HTMLDivElement>(!executing, onReject);
  const displayedCaller = callerId ?? (phase === 'preparing' ? 'Identifying…' : 'Unavailable');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/60 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={executing || phase === 'preparing'}
        aria-labelledby="action-approval-title"
        tabIndex={-1}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-indigo-100 bg-white p-6 shadow-2xl outline-none sm:p-7"
      >
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-700">
          Action approval
        </p>
        <h2 id="action-approval-title" className="mt-2 text-2xl font-semibold tracking-tight">
          {title}
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          The calling manager
          <span className="mt-2 block break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800">
            {displayedCaller}
          </span>
        </p>

        {phase === 'blocked' && error && (
          <p
            role="alert"
            className="mt-5 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900"
          >
            {error}
          </p>
        )}
        {(phase === 'preparing' || phase === 'executing') && status && (
          <p role="status" aria-live="polite" className="mt-5 text-sm text-indigo-700">
            {status}
          </p>
        )}
        {(phase === 'ready' || phase === 'executing') && children}

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <ActionButton tone="secondary" disabled={executing} onClick={onReject}>
            {rejectLabel}
          </ActionButton>
          {phase === 'blocked' ? retryAction : primaryAction}
        </div>
      </div>
    </div>
  );
}
