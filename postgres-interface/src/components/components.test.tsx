import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CreateConnectionDialog } from './CreateConnectionDialog';
import { DeleteConnectionDialog } from './DeleteConnectionDialog';

it('requires explicit approval and returns the selected access', async () => {
  const onDecision = vi.fn();
  render(
    <CreateConnectionDialog
      context={{
        callingManagerId: 'consumer-1',
        requestedAccess: { scope: 'database', operation: 'create', database: 'orders' },
        callerLabels: {},
        databaseNames: ['orders'],
      }}
      onDecision={onDecision}
    />,
  );
  expect(screen.getByRole('dialog', { name: /approve postgresql connection/i })).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: /^approve$/i }));
  expect(onDecision).toHaveBeenCalledWith({
    allowed: true,
    access: { scope: 'database', operation: 'create', database: 'orders' },
  });
});

it('keeps a fixed access proposal read-only', () => {
  render(
    <CreateConnectionDialog
      context={{
        callingManagerId: 'consumer-1',
        requestedAccess: { scope: 'database', operation: 'existing', database: 'warehouse' },
        callerLabels: {},
        databaseNames: ['warehouse'],
      }}
      onDecision={vi.fn()}
    />,
  );
  expect(screen.getByText(/existing database warehouse/i)).toBeVisible();
  expect(screen.queryByRole('textbox', { name: /database/i })).not.toBeInTheDocument();
});

it('allows labels-only requests to choose access and disables empty database approval', async () => {
  render(
    <CreateConnectionDialog
      context={{
        callingManagerId: 'consumer-1',
        requestedAccess: null,
        callerLabels: { team: 'payments' },
        databaseNames: [],
      }}
      onDecision={vi.fn()}
    />,
  );
  expect(screen.getByRole('combobox', { name: /scope/i })).toBeVisible();
  expect(screen.getByRole('button', { name: /^approve$/i })).toBeDisabled();
  await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: /scope/i }), 'full');
  expect(screen.getByRole('button', { name: /^approve$/i })).toBeEnabled();
});

it('warns when full superuser access is selected', async () => {
  render(
    <CreateConnectionDialog
      context={{
        callingManagerId: 'consumer-1',
        requestedAccess: null,
        callerLabels: {},
        databaseNames: ['orders'],
      }}
      onDecision={vi.fn()}
    />,
  );
  await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: /scope/i }), 'full');
  await userEvent.setup().click(screen.getByRole('checkbox', { name: /superuser/i }));
  expect(screen.getByRole('alert')).toHaveTextContent(/full superuser access/i);
});

it('rejects a create approval from Escape', async () => {
  const onDecision = vi.fn();
  render(
    <CreateConnectionDialog
      context={{
        callingManagerId: 'consumer-1',
        requestedAccess: { scope: 'full', superuser: false },
        callerLabels: {},
        databaseNames: [],
      }}
      onDecision={onDecision}
    />,
  );
  await userEvent.setup().keyboard('{Escape}');
  expect(onDecision).toHaveBeenCalledWith({ allowed: false });
});

it('shows whether deleting a connection also removes its managed database', () => {
  render(
    <DeleteConnectionDialog
      context={{
        callingManagerId: 'consumer-1',
        requestedConnectionId: 'connection-1',
        choices: [
          {
            id: 'connection-1',
            access: { scope: 'database', operation: 'create', database: 'orders' },
            authority: { access: 'database', database: 'orders', origin: 'managed' },
            effect: 'role-and-database',
          },
        ],
      }}
      onDecision={vi.fn()}
    />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent(/final manager-created database/i);
});
