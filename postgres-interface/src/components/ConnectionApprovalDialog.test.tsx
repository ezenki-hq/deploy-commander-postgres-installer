import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConnectionApprovalDialog, {
  type ConnectionApprovalDialogProps,
} from './ConnectionApprovalDialog';
import type { ApprovalContext } from '../lib/createPostgresConnection';

afterEach(cleanup);

const completeContext: ApprovalContext = {
  callingManagerId: 'consumer-manager',
  installsPostgres: false,
  requestedAccess: { scope: 'database', operation: 'existing', database: 'orders' },
  callerLabels: { team: 'payments' },
  catalogDatabases: ['orders'],
};

function renderDialog(overrides: Partial<ConnectionApprovalDialogProps> = {}) {
  const props: ConnectionApprovalDialogProps = {
    gate: { kind: 'ready', callerId: 'consumer-manager', context: completeContext },
    request: { access: completeContext.requestedAccess, labels: completeContext.callerLabels },
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onRetry: vi.fn(),
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

  it('shows a prominent warning for a complete superuser request without allowing edits', () => {
    renderDialog({
      gate: {
        kind: 'ready',
        callerId: 'consumer-manager',
        context: { ...completeContext, requestedAccess: { scope: 'full', superuser: true } },
      },
      request: { access: { scope: 'full', superuser: true }, labels: {} },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/every database/i);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('lets the user configure a new database and generate its visible name', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    renderDialog({
      onApprove,
      gate: {
        kind: 'ready',
        callerId: 'consumer-manager',
        context: { ...completeContext, requestedAccess: null, installsPostgres: true },
      },
      request: { access: null, labels: {} },
      generateName: () => 'db_0123456789abcdef0123456789abcdef',
    });
    expect(screen.queryByText(/install PostgreSQL/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve connection/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Generate database name' }));
    expect(screen.getByRole('textbox', { name: /database name/i })).toHaveValue(
      'db_0123456789abcdef0123456789abcdef',
    );
    await user.click(screen.getByRole('button', { name: /approve connection/i }));
    expect(onApprove).toHaveBeenCalledWith({
      scope: 'database',
      operation: 'create',
      database: 'db_0123456789abcdef0123456789abcdef',
    });
  });

  it('offers catalog databases for an existing database request', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    renderDialog({
      onApprove,
      gate: {
        kind: 'ready',
        callerId: 'consumer-manager',
        context: { ...completeContext, requestedAccess: null, catalogDatabases: ['orders', 'analytics'] },
      },
      request: { access: null, labels: {} },
    });
    await user.click(screen.getByRole('radio', { name: /use an existing database/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: /available database/i }), 'analytics');
    await user.click(screen.getByRole('button', { name: /approve connection/i }));
    expect(onApprove).toHaveBeenCalledWith({
      scope: 'database',
      operation: 'existing',
      database: 'analytics',
    });
  });

  it('warns for dedicated superuser access', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    renderDialog({
      onApprove,
      gate: {
        kind: 'ready',
        callerId: 'consumer-manager',
        context: { ...completeContext, requestedAccess: null },
      },
      request: { access: null, labels: {} },
    });
    await user.click(screen.getByRole('radio', { name: /full access/i }));
    await user.click(screen.getByRole('radio', { name: /dedicated superuser/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/every database/i);
    await user.click(screen.getByRole('button', { name: /approve connection/i }));
    expect(onApprove).toHaveBeenCalledWith({ scope: 'full', superuser: true });
  });

  it('disables approval for invalid names and supports Escape rejection', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    renderDialog({
      onReject,
      gate: {
        kind: 'ready',
        callerId: 'consumer-manager',
        context: { ...completeContext, requestedAccess: null },
      },
      request: { access: null, labels: {} },
    });
    const input = screen.getByRole('textbox', { name: /database name/i });
    await user.type(input, 'template0');
    expect(screen.getByRole('button', { name: /approve connection/i })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('keeps preparation visible and approval unavailable until caller resolution', () => {
    renderDialog({
      gate: { kind: 'preparing', callerId: null },
      request: { access: null, labels: {} },
    });
    expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Identifying the calling manager');
    expect(screen.queryByRole('button', { name: /approve connection/i })).not.toBeInTheDocument();
  });

  it('renders blocked recovery with retry and disables controls during execution', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderDialog({
      onRetry,
      gate: {
        kind: 'blocked',
        callerId: 'consumer-manager',
        failure: { status: 503, message: 'PostgreSQL recovery is required', retryable: true },
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('PostgreSQL recovery is required');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();

    cleanup();
    renderDialog({
      gate: { kind: 'executing', callerId: 'consumer-manager', context: completeContext },
    });
    expect(screen.getByRole('status')).toHaveTextContent('Creating PostgreSQL connection');
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  });
});
