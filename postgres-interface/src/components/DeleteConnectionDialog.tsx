import type { DeleteApprovalContext, DeleteApprovalDecision } from '../workflows/deleteConnection';
import { useState } from 'react';
import { ApprovalDialog } from './ApprovalDialog';

export function DeleteConnectionDialog({
  context,
  onDecision,
}: {
  context: DeleteApprovalContext;
  onDecision: (decision: DeleteApprovalDecision) => void;
}) {
  const initial = context.requestedConnectionId ?? context.choices[0]?.id ?? '';
  const [selected, setSelected] = useState(initial);
  const choice = context.choices.find((item) => item.id === selected);
  return (
    <ApprovalDialog
      title="Approve PostgreSQL connection deletion"
      tone="danger"
      onReject={() => onDecision({ allowed: false })}
      onApprove={() => onDecision({ allowed: true, connectionId: selected })}
      approveDisabled={!choice}
    >
      {context.requestedConnectionId ? (
        <p className="leading-6">
          Delete connection <code>{context.requestedConnectionId}</code>?
        </p>
      ) : (
        <label className="grid gap-2 font-medium text-slate-800">
          <span>Connection</span>
          <select
            className="rounded-lg border border-slate-300 bg-white px-3 py-2"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {context.choices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {choice && (
        <p
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900"
        >
          {choice.effect === 'role-and-database'
            ? 'This removes the connection role and the final manager-created database.'
            : 'This removes the connection role; the database is preserved.'}
        </p>
      )}
    </ApprovalDialog>
  );
}
