import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DeleteConnectionDialog, { type DeleteConnectionDialogProps } from './DeleteConnectionDialog';

const created = {
  id: 'connection-created',
  access: { scope: 'database' as const, operation: 'create' as const, database: 'orders' },
};
const existing = {
  id: 'connection-existing',
  access: { scope: 'database' as const, operation: 'existing' as const, database: 'warehouse' },
};
const full = { id: 'connection-full', access: { scope: 'full' as const, superuser: false } };
function renderDialog(overrides: Partial<DeleteConnectionDialogProps> = {}) {
  const props: DeleteConnectionDialogProps = {
    context: {
      callingManagerId: 'consumer-manager',
      requestedConnectionId: null,
      choices: [created],
    },
    busy: false,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    ...overrides,
  };
  return { ...render(<DeleteConnectionDialog {...props} />), props };
}

describe('DeleteConnectionDialog', () => {
  afterEach(() => cleanup());
  it('requires selection and explains the destructive consequence', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    renderDialog({
      context: {
        callingManagerId: 'consumer-manager',
        requestedConnectionId: null,
        choices: [created, existing, full],
      },
      onApprove,
    });
    const dialog = screen.getByRole('dialog', { name: 'Delete PostgreSQL connection?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Delete connection' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /connection-created.*orders/i }));
    expect(screen.getByText(/database and user will be deleted/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete connection' }));
    expect(onApprove).toHaveBeenCalledWith('connection-created');
  });
  it.each([
    [existing, 'Only the connection user will be deleted'],
    [full, 'Only the connection user will be deleted'],
  ] as const)('preserves databases for %#', (choice, message) => {
    renderDialog({
      context: {
        callingManagerId: 'consumer-manager',
        requestedConnectionId: choice.id,
        choices: [choice],
      },
    });
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
  it('traps focus and permits Escape or Cancel before submission', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    renderDialog({
      context: {
        callingManagerId: 'consumer-manager',
        requestedConnectionId: created.id,
        choices: [created],
      },
      onReject,
    });
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog).toHaveFocus());
    await user.tab();
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(onReject).toHaveBeenCalledOnce();
  });
  it('locks dismissal and announces work while busy', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    renderDialog({
      context: {
        callingManagerId: 'consumer-manager',
        requestedConnectionId: created.id,
        choices: [created],
      },
      busy: true,
      onReject,
    });
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Deleting PostgreSQL connection');
    expect(screen.getByRole('button', { name: 'Delete connection' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onReject).not.toHaveBeenCalled();
  });
  it('never renders credentials or remembered approval', () => {
    renderDialog({
      context: {
        callingManagerId: 'consumer-manager',
        requestedConnectionId: created.id,
        choices: [created],
      },
    });
    expect(screen.queryByText(/logical-password|admin-password/)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /remember|again/i })).not.toBeInTheDocument();
  });
});
