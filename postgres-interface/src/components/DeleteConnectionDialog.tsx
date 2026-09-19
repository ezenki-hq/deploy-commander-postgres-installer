import ActionApprovalDialog from './ActionApprovalDialog';
import ActionButton from './ActionButton';
import type { ActionGateState } from '../lib/actionGate';
import type { DeleteConnectionApprovalContext } from '../lib/deletePostgresConnection';

export interface DeleteConnectionDialogProps {
  gate: ActionGateState<DeleteConnectionApprovalContext>;
  onApprove: (connectionId: string) => void;
  onReject: () => void;
  onRetry: () => void;
}

function description(choice: DeleteConnectionApprovalContext['choices'][number]): string {
  if (choice.access.scope === 'database') {
    return `${choice.access.operation === 'create' ? 'Created database' : 'Existing database'}: ${choice.access.database}`;
  }
  return choice.access.superuser ? 'Full access (superuser)' : 'Full access (constrained)';
}

function deletesDatabase(choice: DeleteConnectionApprovalContext['choices'][number]): boolean {
  return choice.cleanup === 'role-and-database';
}

export default function DeleteConnectionDialog({
  gate,
  onApprove,
  onReject,
  onRetry,
}: DeleteConnectionDialogProps) {
  const context = gate.kind === 'ready' || gate.kind === 'executing' ? gate.context : null;
  const selected = context?.requestedConnectionId ?? context?.choices[0]?.id ?? null;
  const selectedChoice = context?.choices.find((choice) => choice.id === selected) ?? null;
  const controls = context ? (
    <>
      {context.requestedConnectionId === null ? (
        <fieldset className="mt-5 space-y-3">
          <legend className="text-sm font-semibold text-slate-800">Connection to delete</legend>
          {context.choices.map((choice) => (
            <div key={choice.id} className="rounded-xl border border-slate-200 p-3 text-sm">
              <span className="block break-all font-mono font-semibold text-slate-800">
                {choice.id}
              </span>
              <span className="block text-slate-600">{description(choice)}</span>
            </div>
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
    </>
  ) : null;
  return (
    <ActionApprovalDialog
      title="Delete PostgreSQL connection?"
      callerId={gate.kind === 'closed' ? null : gate.callerId}
      phase={gate.kind === 'closed' ? 'preparing' : gate.kind}
      status={
        gate.kind === 'executing'
          ? 'Deleting PostgreSQL connection…'
          : 'Checking connection ownership before approval…'
      }
      error={gate.kind === 'blocked' ? gate.failure.message : undefined}
      onReject={onReject}
      retryAction={
        <ActionButton tone="secondary" onClick={onRetry}>
          Retry
        </ActionButton>
      }
      primaryAction={
        selectedChoice ? (
          <ActionButton tone="danger" onClick={() => onApprove(selectedChoice.id)}>
            Delete connection
          </ActionButton>
        ) : undefined
      }
    >
      {controls}
    </ActionApprovalDialog>
  );
}
