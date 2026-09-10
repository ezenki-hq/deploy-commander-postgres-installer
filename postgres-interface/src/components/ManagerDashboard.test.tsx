import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ManagerDashboard from './ManagerDashboard';
import type { PrimaryState } from '../lib/primaryState';

const resource = {
  id: 'resource-1', type: 'postgres', name: 'postgres', external: false,
  manager: 'postgres-manager',
  created_at: '2026-08-30T00:00:00.000Z', updated_at: '2026-08-30T00:00:00.000Z',
};
const primary: PrimaryState = {
  phase: 'ready', operationId: 'install-1',
  credentials: { username: 'pg_admin_hidden', password: 'never-render' },
  runId: 'run-1', resourceId: 'resource-1', initializedAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
};

afterEach(() => cleanup());

function renderDashboard(overrides: Partial<React.ComponentProps<typeof ManagerDashboard>> = {}) {
  return render(<ManagerDashboard
    resource={null}
    primary={null}
    activeAction={null}
    error={null}
    permissionRemembered={false}
    onInstall={vi.fn()}
    onTeardown={vi.fn()}
    onRetry={vi.fn()}
    onResetPermission={vi.fn()}
    {...overrides}
  />);
}

describe('ManagerDashboard', () => {
  it('offers installation when no PostgreSQL resource exists', () => {
    const onInstall = vi.fn();
    renderDashboard({ onInstall });
    expect(screen.getByRole('heading', { name: 'Install PostgreSQL' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install PostgreSQL' }));
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it('shows an installation failure while still allowing a fresh install', () => {
    const onInstall = vi.fn();
    renderDashboard({ error: 'PostgreSQL installation failed', failedAction: 'install', onInstall });
    expect(screen.getByRole('alert')).toHaveTextContent('PostgreSQL installation failed');
    fireEvent.click(screen.getByRole('button', { name: 'Install PostgreSQL' }));
    expect(onInstall).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Retry recovery' })).not.toBeInTheDocument();
  });

  it('shows the installed card and requires confirmation before teardown', () => {
    const onTeardown = vi.fn();
    renderDashboard({ resource, primary, permissionRemembered: true, onTeardown });
    expect(screen.getByRole('heading', { name: 'PostgreSQL is installed' })).toBeInTheDocument();
    expect(screen.getByText('Remembered for this installation')).toBeInTheDocument();
    expect(screen.getByText('resource-1')).toBeInTheDocument();
    expect(screen.queryByText('pg_admin_hidden')).not.toBeInTheDocument();
    expect(screen.queryByText('never-render')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Teardown PostgreSQL' }));
    expect(screen.getByRole('dialog', { name: 'Teardown PostgreSQL?' })).toBeVisible();
    expect(onTeardown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm teardown' }));
    expect(onTeardown).toHaveBeenCalledOnce();
  });

  it('cancels teardown confirmation without submitting', () => {
    const onTeardown = vi.fn();
    renderDashboard({ resource, primary, onTeardown });
    fireEvent.click(screen.getByRole('button', { name: 'Teardown PostgreSQL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onTeardown).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Teardown PostgreSQL?' })).not.toBeInTheDocument();
  });

  it('cancels teardown confirmation with Escape without submitting', () => {
    const onTeardown = vi.fn();
    renderDashboard({ resource, primary, onTeardown });
    fireEvent.click(screen.getByRole('button', { name: 'Teardown PostgreSQL' }));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Teardown PostgreSQL?' }), { key: 'Escape' });
    expect(onTeardown).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Teardown PostgreSQL?' })).not.toBeInTheDocument();
  });

  it('shows persisted recovery state with a retry action', () => {
    const onRetry = vi.fn();
    renderDashboard({ resource, primary: { ...primary, phase: 'install-running' }, activeAction: null, onRetry });
    expect(screen.getByRole('heading', { name: 'PostgreSQL installation needs recovery' })).toBeInTheDocument();
    expect(screen.getByText(/installation state is incomplete/i)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry recovery' });
    expect(retry).not.toBeDisabled();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('identifies legacy resources and allows teardown without offering a new install', () => {
    const onTeardown = vi.fn();
    renderDashboard({ resource, onTeardown });
    expect(screen.getByRole('heading', { name: 'PostgreSQL requires reinstall' })).toBeInTheDocument();
    expect(screen.getByText(/predates private administrator state/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install PostgreSQL' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Teardown PostgreSQL' }));
    expect(onTeardown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm teardown' }));
    expect(onTeardown).toHaveBeenCalledOnce();
  });

  it('offers an actual teardown retry after a failed teardown', () => {
    const onTeardown = vi.fn();
    renderDashboard({ resource, primary: { ...primary, phase: 'teardown-failed' }, onTeardown });
    fireEvent.click(screen.getByRole('button', { name: 'Retry teardown' }));
    expect(onTeardown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm teardown' }));
    expect(onTeardown).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Retry recovery' })).not.toBeInTheDocument();
  });

  it('supports resetting only the current remembered permission', () => {
    const onResetPermission = vi.fn();
    renderDashboard({ resource, primary, permissionRemembered: true, onResetPermission });
    fireEvent.click(screen.getByRole('button', { name: 'Reset remembered connection approval' }));
    expect(onResetPermission).toHaveBeenCalledOnce();
  });

  it('renders non-secret errors and no credential values', () => {
    renderDashboard({ error: 'PostgreSQL recovery is required', primary });
    expect(screen.getAllByText('PostgreSQL recovery is required')).toHaveLength(1);
    expect(screen.queryByText('pg_admin_hidden')).not.toBeInTheDocument();
    expect(screen.queryByText('never-render')).not.toBeInTheDocument();
  });

  it('does not show Ready when an error accompanies ready state', () => {
    renderDashboard({ error: 'PostgreSQL recovery is required', resource, primary });

    expect(screen.getByText('Attention')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'PostgreSQL manager needs attention' })).toBeInTheDocument();
  });

  it('does not show Ready when the resource state is ambiguous', () => {
    renderDashboard({ resourceAmbiguous: true, resource, primary });

    expect(screen.getByText('Attention')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'PostgreSQL resource state is ambiguous' })).toBeInTheDocument();
  });

  it('keeps teardown retry precedence over a supplied action error', () => {
    const onTeardown = vi.fn();
    renderDashboard({ resource, primary: { ...primary, phase: 'teardown-failed' }, error: 'Unable to complete PostgreSQL lifecycle action', onTeardown });

    expect(screen.getByText('Recovery')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry teardown' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry recovery' })).not.toBeInTheDocument();
  });

  it('describes normal installation progress without recovery wording', () => {
    renderDashboard({ activeAction: 'install' });
    expect(screen.getByRole('status')).toHaveTextContent('Installing PostgreSQL');
    expect(screen.queryByText(/needs recovery/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install PostgreSQL' })).not.toBeInTheDocument();
  });

  it('describes normal teardown progress without recovery wording', () => {
    renderDashboard({ resource, primary, activeAction: 'teardown' });
    expect(screen.getByRole('status')).toHaveTextContent('Tearing down PostgreSQL');
    expect(screen.queryByText(/needs recovery/i)).not.toBeInTheDocument();
  });

  it('renders a supplied recovery error exactly once', () => {
    renderDashboard({ error: 'PostgreSQL recovery is required', primary });
    expect(screen.getAllByText('PostgreSQL recovery is required')).toHaveLength(1);
  });
});
