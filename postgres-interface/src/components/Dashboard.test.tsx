import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dashboard } from './Dashboard';

const resource: RPC.ResourceItem = {
  id: 'resource-1',
  manager: 'postgres-manager',
  agent: 'agent-1',
  type: 'postgres',
  name: 'postgres',
  external: false,
  created_at: '2026-09-20T00:00:00Z',
  updated_at: '2026-09-20T00:00:00Z',
};

describe('Dashboard', () => {
  it('renders only Install for a not-installed projection', () => {
    render(
      <Dashboard
        projection={{ installation: { kind: 'not-installed' }, connectionCount: 0 }}
        onInstall={vi.fn()}
        onTeardown={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByRole('button', { name: /install postgresql/i })).toBeVisible();
    expect(screen.queryByRole('button', { name: /teardown/i })).not.toBeInTheDocument();
  });

  it('renders installed state and Teardown from the supplied projection', () => {
    render(
      <Dashboard
        projection={{ installation: { kind: 'installed', resource }, connectionCount: 3 }}
        onInstall={vi.fn()}
        onTeardown={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByText(/3 managed connections/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /teardown postgresql/i })).toBeVisible();
  });

  it('keeps the current projection visible while showing a root error', () => {
    render(
      <Dashboard
        projection={{ installation: { kind: 'installed', resource }, connectionCount: 1 }}
        onInstall={vi.fn()}
        onTeardown={vi.fn()}
        busy={false}
        error="Unable to refresh PostgreSQL state"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to refresh PostgreSQL state');
    expect(screen.getByRole('button', { name: /teardown postgresql/i })).toBeVisible();
  });
});
