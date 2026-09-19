import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ActionApprovalDialog from './ActionApprovalDialog';

afterEach(cleanup);

describe('ActionApprovalDialog', () => {
  it('keeps a preparing request modal and cancellable', async () => {
    const user = userEvent.setup();
    const reject = vi.fn();
    render(
      <ActionApprovalDialog
        title="Approve PostgreSQL access?"
        callerId="consumer-manager"
        phase="preparing"
        status="Checking PostgreSQL installation"
        onReject={reject}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Checking PostgreSQL installation');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(reject).toHaveBeenCalledOnce();
  });

  it('renders a missing caller as blocked without an approve action', () => {
    render(
      <ActionApprovalDialog
        title="Approve PostgreSQL access?"
        callerId={null}
        phase="blocked"
        error="A calling manager is required"
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('A calling manager is required');
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });
});
