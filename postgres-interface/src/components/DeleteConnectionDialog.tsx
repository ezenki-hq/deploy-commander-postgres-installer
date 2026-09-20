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
      onReject={() => onDecision({ allowed: false })}
      onApprove={() => onDecision({ allowed: true, connectionId: selected })}
      approveDisabled={!choice}
    >
      {context.requestedConnectionId ? (
        <p>
          Delete connection <code>{context.requestedConnectionId}</code>?
        </p>
      ) : (
        <label>
          Connection
          <select value={selected} onChange={(event) => setSelected(event.target.value)}>
            {context.choices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {choice && (
        <p>
          {choice.effect === 'role-and-database'
            ? 'This removes the connection role and the final manager-created database.'
            : 'This removes the connection role; the database is preserved.'}
        </p>
      )}
    </ApprovalDialog>
  );
}
