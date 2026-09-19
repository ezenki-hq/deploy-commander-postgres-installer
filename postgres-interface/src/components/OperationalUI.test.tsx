import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ActionButton from './ActionButton';
import ManagerShell from './ManagerShell';
import StatusPanel from './StatusPanel';

afterEach(cleanup);

describe('operational console primitives', () => {
  it('provides one labelled manager shell with an optional health badge', () => {
    render(
      <ManagerShell badge={{ label: 'Ready', tone: 'success' }}>
        <p>Manager content</p>
      </ManagerShell>,
    );

    expect(screen.getByRole('heading', { name: 'PostgreSQL manager' })).toBeVisible();
    expect(screen.getByRole('main')).toHaveAttribute(
      'data-manager-build',
      'postgres-action-approval-gate-v1',
    );
    expect(screen.getByText('Ready')).toBeVisible();
    expect(screen.getByText('Manager content')).toBeVisible();
  });

  it('announces status and alert panels according to their role', () => {
    const view = render(
      <StatusPanel tone="progress" title="Installing PostgreSQL" role="status">
        Persistent storage is being prepared.
      </StatusPanel>,
    );
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');

    view.rerender(
      <StatusPanel tone="danger" title="Storage unavailable" role="alert">
        Retry manager initialization.
      </StatusPanel>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Storage unavailable');
  });

  it('keeps action variants accessible and single-shot while disabled', async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    const view = render(
      <ActionButton tone="danger" disabled onClick={action}>
        Confirm teardown
      </ActionButton>,
    );
    await user.click(screen.getByRole('button', { name: 'Confirm teardown' }));
    expect(action).not.toHaveBeenCalled();

    view.rerender(
      <ActionButton tone="primary" onClick={action}>
        Install PostgreSQL
      </ActionButton>,
    );
    await user.click(screen.getByRole('button', { name: 'Install PostgreSQL' }));
    expect(action).toHaveBeenCalledOnce();
  });
});
