import { useState } from 'react';
import ActionButton from './ActionButton';
import useDialogFocus from './useDialogFocus';
import type { DeleteConnectionApprovalContext } from '../lib/deletePostgresConnection';

export interface DeleteConnectionDialogProps {
  context: DeleteConnectionApprovalContext;
  busy: boolean;
  onApprove: (connectionId: string) => void;
  onReject: () => void;
}

function description(choice: DeleteConnectionApprovalContext['choices'][number]): string {
  if (choice.access.scope === 'database') {
    return `${choice.access.operation === 'create' ? 'Created database' : 'Existing database'}: ${choice.access.database}`;
  }
  return choice.access.superuser ? 'Full access (superuser)' : 'Full access (constrained)';
}

function deletesDatabase(choice: DeleteConnectionApprovalContext['choices'][number]): boolean {
  return choice.access.scope === 'database' && choice.access.operation === 'create';
}

export default function DeleteConnectionDialog({
  context,
  busy,
  onApprove,
  onReject,
}: DeleteConnectionDialogProps) {
  const initial = context.requestedConnectionId ?? null;
  const [selected, setSelected] = useState<string | null>(initial);
  const selectedChoice = context.choices.find((choice) => choice.id === selected) ?? null;
  const dialogRef = useDialogFocus<HTMLDivElement>(!busy, onReject);
  const approve = () => {
    if (!busy && selectedChoice) onApprove(selectedChoice.id);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/60 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        tabIndex={-1}
        aria-labelledby="delete-connection-title"
        aria-describedby="delete-connection-description"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-rose-100 bg-white p-6 shadow-2xl outline-none sm:p-7"
      >
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-rose-700">
          Connection deletion
        </p>
        <h2 id="delete-connection-title" className="mt-2 text-2xl font-semibold tracking-tight">
          Delete PostgreSQL connection?
        </h2>
        <p id="delete-connection-description" className="mt-3 text-sm leading-6 text-slate-600">
          The calling manager{' '}
          <span className="mt-2 block break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800">
            {context.callingManagerId}
          </span>{' '}
          must confirm this destructive action.
        </p>

        {context.requestedConnectionId === null ? (
          <fieldset className="mt-5 space-y-3">
            <legend className="text-sm font-semibold text-slate-800">Connection to delete</legend>
            {context.choices.map((choice) => (
              <label
                key={choice.id}
                className="flex items-start gap-3 rounded-xl border border-slate-200 p-3 text-sm"
              >
                <input
                  type="radio"
                  name="delete-connection"
                  value={choice.id}
                  checked={selected === choice.id}
                  disabled={busy}
                  onChange={() => setSelected(choice.id)}
                  aria-label={`${choice.id} ${choice.access.scope === 'database' ? choice.access.database : 'full access'}`}
                />
                <span>
                  <span className="block break-all font-mono font-semibold text-slate-800">
                    {choice.id}
                  </span>
                  <span className="block text-slate-600">{description(choice)}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : selectedChoice ? (
          <div className="mt-5 rounded-xl bg-slate-50 p-4 text-sm">
            <p className="font-semibold text-slate-500">Connection</p>
            <p className="mt-1 break-all font-mono text-slate-800">{selectedChoice.id}</p>
            <p className="mt-2 text-slate-600">{description(selectedChoice)}</p>
          </div>
        ) : null}

        {selectedChoice && (
          <p className="mt-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm font-semibold text-rose-900">
            {deletesDatabase(selectedChoice)
              ? 'The database and user will be deleted.'
              : 'Only the connection user will be deleted'}
          </p>
        )}
        {busy && (
          <p role="status" className="mt-4 text-sm text-slate-600">
            Deleting PostgreSQL connection
          </p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <ActionButton tone="secondary" disabled={busy} onClick={onReject}>
            Cancel
          </ActionButton>
          <ActionButton tone="danger" disabled={busy || !selectedChoice} onClick={approve}>
            Delete connection
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
