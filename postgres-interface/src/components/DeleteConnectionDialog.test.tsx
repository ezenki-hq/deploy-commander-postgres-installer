import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import DeleteConnectionDialog from './DeleteConnectionDialog';
import type { ActionGateState } from '../lib/actionGate';
import type { DeleteConnectionApprovalContext } from '../lib/deletePostgresConnection';

const context: DeleteConnectionApprovalContext = { callingManagerId: 'consumer-manager', requestedConnectionId: 'connection-1', choices: [{ id: 'connection-1', access: { scope: 'database', operation: 'create', database: 'orders' } }] };
const ready: ActionGateState<DeleteConnectionApprovalContext> = { kind: 'ready', callerId: 'consumer-manager', context };
describe('DeleteConnectionDialog', () => {
  it('requires explicit approval and explains the destructive consequence', async () => {
    const onApprove = vi.fn();
    render(<DeleteConnectionDialog gate={ready} onApprove={onApprove} onReject={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Delete PostgreSQL connection?' })).toBeVisible();
    expect(screen.getByText(/database and user will be deleted/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete connection' })).toBeEnabled();
  });
  it('shows preparation and blocked states without destructive controls', () => {
    const { rerender } = render(<DeleteConnectionDialog gate={{ kind: 'preparing', callerId: null }} onApprove={vi.fn()} onReject={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/checking connection ownership/i);
    rerender(<DeleteConnectionDialog gate={{ kind: 'blocked', callerId: null, failure: { status: 400, message: 'A calling manager is required', retryable: false } }} onApprove={vi.fn()} onReject={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/calling manager/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
