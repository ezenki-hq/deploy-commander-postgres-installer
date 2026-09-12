import { useState } from 'react';
import ActionButton from './ActionButton';
import useDialogFocus from './useDialogFocus';

export interface PermissionDialogProps {
  callerId: string;
  busy: boolean;
  installsPostgres?: boolean;
  onAllow: (remember: boolean) => void;
  onCancel: () => void;
}

export function PermissionDialog({
  callerId,
  busy,
  installsPostgres = false,
  onAllow,
  onCancel,
}: PermissionDialogProps) {
  const [remember, setRemember] = useState(false);
  const dialogRef = useDialogFocus<HTMLDivElement>(!busy, onCancel);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/60 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        tabIndex={-1}
        aria-labelledby="permission-dialog-title"
        aria-describedby="permission-dialog-description"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-indigo-100 bg-white p-6 shadow-2xl outline-none sm:p-7"
      >
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-700">Permission request</p>
        <h2 id="permission-dialog-title" className="mt-2 text-2xl font-semibold tracking-tight">
          Allow PostgreSQL connection?
        </h2>
        <p id="permission-dialog-description" className="mt-3 text-sm leading-6 text-slate-600">
          The calling manager
          <span
            data-testid="calling-manager-id"
            className="mt-2 block break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800"
          >
            {callerId}
          </span>
          {installsPostgres
            ? 'This request will install PostgreSQL, then create a logical database and credentials.'
            : 'requests a logical database and credentials from this PostgreSQL installation.'}
        </p>
        <label className="mt-5 flex items-start gap-2 text-sm leading-6 text-slate-700">
          <input
            type="checkbox"
            checked={remember}
            disabled={busy}
            onChange={(event) => setRemember(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
          />
          <span>
            Don&apos;t ask me again. This gives installation-wide approval for all future callers.
          </span>
        </label>
        {busy && (
          <p role="status" aria-live="polite" className="mt-4 text-sm font-medium text-indigo-700">
            Requesting access…
          </p>
        )}
        <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <ActionButton tone="secondary" disabled={busy} onClick={onCancel}>Cancel</ActionButton>
          <ActionButton tone="primary" disabled={busy} onClick={() => onAllow(remember)}>Allow</ActionButton>
        </div>
      </div>
    </div>
  );
}

export default PermissionDialog;
