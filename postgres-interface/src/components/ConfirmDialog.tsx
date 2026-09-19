import ActionButton from './ActionButton';
import useDialogFocus from './useDialogFocus';

export interface ConfirmDialogProps {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(!busy, onCancel);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/60 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        tabIndex={-1}
        aria-labelledby="teardown-dialog-title"
        aria-describedby="teardown-dialog-description"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-rose-100 bg-white p-6 shadow-2xl outline-none sm:p-7"
      >
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-rose-700">
          Destructive action
        </p>
        <h2 id="teardown-dialog-title" className="mt-2 text-2xl font-semibold tracking-tight">
          Teardown PostgreSQL?
        </h2>
        <p id="teardown-dialog-description" className="mt-3 text-sm leading-6 text-slate-600">
          The shared PostgreSQL service and its logical databases will be removed. This action
          cannot be undone from this manager.
        </p>
        {busy && (
          <p role="status" aria-live="polite" className="mt-4 text-sm font-medium text-rose-700">
            Starting teardown…
          </p>
        )}
        <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <ActionButton tone="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </ActionButton>
          <ActionButton tone="danger" disabled={busy} onClick={onConfirm}>
            Confirm teardown
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
