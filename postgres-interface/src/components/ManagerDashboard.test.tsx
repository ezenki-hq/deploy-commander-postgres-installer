import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ManagerDashboard from './ManagerDashboard';

const resource = { id: 'resource-1', type: 'postgres', name: 'postgres', external: false, manager: 'manager', created_at: 'now', updated_at: 'now' };
afterEach(cleanup);
function renderDashboard(overrides: Partial<React.ComponentProps<typeof ManagerDashboard>> = {}) {
  return render(<ManagerDashboard lifecycle={{ kind: 'not-installed' }} resource={null} resourceCompatible={false} resourceAmbiguous={false} resourceContradiction={false} activeAction={null} error={null} permissionRemembered={false} onInstall={vi.fn()} onTeardown={vi.fn()} onRetry={vi.fn()} onResetPermission={vi.fn()} {...overrides} />);
}
describe('ManagerDashboard', () => {
  it('renders run-backed installation progress after reload', () => { renderDashboard({ lifecycle: { kind: 'installing', runId: 'run-1' } }); expect(screen.getByRole('status')).toHaveTextContent('Installing PostgreSQL'); });
  it('renders a compatible installed resource', () => { renderDashboard({ lifecycle: { kind: 'installed', runId: 'run-2', operationBusy: false }, resource, resourceCompatible: true }); expect(screen.getByRole('heading', { name: 'PostgreSQL is installed' })).toBeVisible(); });
  it('offers installation after a failed run', () => { const onInstall = vi.fn(); renderDashboard({ lifecycle: { kind: 'installation-failed', runId: 'run-3' }, onInstall }); fireEvent.click(screen.getByRole('button', { name: 'Install PostgreSQL' })); expect(onInstall).toHaveBeenCalledOnce(); });
  it('offers teardown retry after failure', () => { renderDashboard({ lifecycle: { kind: 'teardown-failed', runId: 'run-4' }, resource, resourceCompatible: true }); expect(screen.getByRole('button', { name: 'Retry teardown' })).toBeVisible(); });
  it('shows busy connection runs while preserving installed identity', () => { renderDashboard({ lifecycle: { kind: 'installed', runId: 'connection-1', operationBusy: true }, resource, resourceCompatible: true }); expect(screen.getByRole('heading', { name: 'PostgreSQL is installed' })).toBeVisible(); expect(screen.getByText(/operation is already in progress/i)).toBeVisible(); expect(screen.getByRole('button', { name: 'Teardown PostgreSQL' })).toBeDisabled(); });
  it('offers teardown for an incompatible resource', () => { renderDashboard({ lifecycle: { kind: 'installed', runId: 'run-1', operationBusy: false }, resource, resourceCompatible: false }); expect(screen.getByRole('heading', { name: 'PostgreSQL resource needs recovery' })).toBeVisible(); fireEvent.click(screen.getByRole('button', { name: 'Teardown PostgreSQL' })); expect(screen.getByRole('dialog')).toBeVisible(); });
  it('prioritizes multiple resources', () => { renderDashboard({ lifecycle: { kind: 'installed', runId: 'run-1', operationBusy: false }, resource, resourceCompatible: true, resourceAmbiguous: true }); expect(screen.getByRole('heading', { name: 'PostgreSQL resource state is ambiguous' })).toBeVisible(); });
  it('renders a contradiction warning', () => { renderDashboard({ lifecycle: { kind: 'not-installed' }, resource, resourceCompatible: true, resourceContradiction: true }); expect(screen.getByRole('heading', { name: 'PostgreSQL state needs recovery' })).toBeVisible(); });
});
