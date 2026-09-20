import type { ReactNode } from 'react';
import { ActionButton } from './ActionButton';
import { ModalDialog } from './ModalDialog';

export function ApprovalDialog({
  title,
  children,
  approveLabel = 'Approve',
  onApprove,
  onReject,
  approveDisabled = false,
  busy = false,
  tone = 'neutral',
}: {
  title: string;
  children: ReactNode;
  approveLabel?: string;
  onApprove: () => void;
  onReject: () => void;
  approveDisabled?: boolean;
  busy?: boolean;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <ModalDialog
      title={title}
      onCancel={onReject}
      busy={busy}
      tone={tone}
      actions={
        <>
          <ActionButton tone="secondary" onClick={onReject} busy={busy}>
            Reject
          </ActionButton>
          <ActionButton
            tone={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onApprove}
            disabled={approveDisabled}
            busy={busy}
          >
            {approveLabel}
          </ActionButton>
        </>
      }
    >
      {children}
    </ModalDialog>
  );
}
