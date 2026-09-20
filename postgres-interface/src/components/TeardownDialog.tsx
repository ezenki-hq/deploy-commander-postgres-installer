import { ActionButton } from './ActionButton';
import { ModalDialog } from './ModalDialog';

export interface TeardownDialogProps {
  busy: boolean;
  onDecision: (confirmed: boolean) => void;
}

export function TeardownDialog({ busy, onDecision }: TeardownDialogProps) {
  return (
    <ModalDialog
      title="Teardown PostgreSQL"
      description="This destructive action removes the PostgreSQL service and every database managed by it."
      tone="danger"
      busy={busy}
      onCancel={() => onDecision(false)}
      actions={
        <>
          <ActionButton tone="secondary" onClick={() => onDecision(false)} busy={busy}>
            Cancel
          </ActionButton>
          <ActionButton tone="danger" onClick={() => onDecision(true)} busy={busy}>
            Confirm teardown
          </ActionButton>
        </>
      }
    >
      <p>
        Existing connections are cleaned up according to their current resource and connection
        labels. Cancel if you want to keep the installed service.
      </p>
    </ModalDialog>
  );
}
