import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConnectionApprovalDialog, { type ConnectionApprovalDialogProps } from './ConnectionApprovalDialog';

afterEach(cleanup);

const completeContext: ConnectionApprovalDialogProps['context'] = {
  callingManagerId: 'consumer-manager',
  installsPostgres: false,
  requestedAccess: { scope: 'database', operation: 'existing', database: 'orders' },
  callerLabels: { team: 'payments' },
  catalogDatabases: ['orders'],
};

function renderDialog(overrides: Partial<ConnectionApprovalDialogProps> = {}) {
  const props: ConnectionApprovalDialogProps = {
    context: completeContext,
    busy: false,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    ...overrides,
  };
  return { ...render(<ConnectionApprovalDialog {...props} />), props };
}

describe('ConnectionApprovalDialog', () => {
  it('reviews complete manager requests without editable access controls', () => {
    renderDialog();

    expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible();
    expect(screen.getByText('orders')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /database name/i })).not.toBeInTheDocument();
    expect(screen.getByText('team=payments')).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /remember|again/i })).not.toBeInTheDocument();
  });

  it('approves the exact complete request', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    renderDialog({ onApprove });

    await user.click(screen.getByRole('button', { name: 'Approve connection' }));
    expect(onApprove).toHaveBeenCalledWith(completeContext.requestedAccess);
  });

  it('lets the user configure a new database and generate its visible name', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    renderDialog({
      onApprove,
      context: { ...completeContext, requestedAccess: null, installsPostgres: true },
      generateName: () => 'db_0123456789abcdef0123456789abcdef',
    });

    expect(screen.getByText(/install PostgreSQL/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /approve connection/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Generate database name' }));
    expect(screen.getByRole('textbox', { name: /database name/i })).toHaveValue('db_0123456789abcdef0123456789abcdef');
    await user.click(screen.getByRole('button', { name: /approve connection/i }));
    expect(onApprove).toHaveBeenCalledWith({
      scope: 'database', operation: 'create', database: 'db_0123456789abcdef0123456789abcdef',
    });
  });

  it('offers catalog databases for an existing database request', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    renderDialog({
      onApprove,
      context: { ...completeContext, requestedAccess: null, catalogDatabases: ['orders', 'analytics'] },
    });

    await user.click(screen.getByRole('radio', { name: /use an existing database/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: /available database/i }), 'analytics');
    await user.click(screen.getByRole('button', { name: /approve connection/i }));
    expect(onApprove).toHaveBeenCalledWith({ scope: 'database', operation: 'existing', database: 'analytics' });
  });

  it('warns for dedicated superuser access', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    renderDialog({ onApprove, context: { ...completeContext, requestedAccess: null } });

    await user.click(screen.getByRole('radio', { name: /full access/i }));
    await user.click(screen.getByRole('radio', { name: /dedicated superuser/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/every database/i);
    await user.click(screen.getByRole('button', { name: /approve connection/i }));
    expect(onApprove).toHaveBeenCalledWith({ scope: 'full', superuser: true });
  });

  it('disables approval for invalid names and supports Escape rejection', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    renderDialog({ onReject, context: { ...completeContext, requestedAccess: null } });

    const input = screen.getByRole('textbox', { name: /database name/i });
    await user.type(input, 'template0');
    expect(screen.getByRole('button', { name: /approve connection/i })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('disables controls and announces busy state', () => {
    renderDialog({ busy: true });

    expect(screen.getByRole('status')).toHaveTextContent('Requesting access');
    expect(screen.getByRole('button', { name: /approve connection/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  });
});
