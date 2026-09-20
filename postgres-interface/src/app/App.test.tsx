import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppServices } from './App';
import App from './App';
import type { DashboardProjection } from '../platform/dashboardProjection';
import type { InstallationProjection } from '../platform/resources';
import { fakeCaller, testEventSource } from '../test/fakes';
import type { InterfaceClient } from '../platform/interfaceClient';

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
const notInstalled: DashboardProjection = {
  installation: { kind: 'not-installed' },
  connectionCount: 0,
};
const installed: InstallationProjection = { kind: 'installed', resource };
const installedDashboard: DashboardProjection = { installation: installed, connectionCount: 2 };

function rootClient(): InterfaceClient {
  const caller = fakeCaller({
    getManager: vi.fn().mockResolvedValue('postgres-manager'),
    getCallingManager: vi.fn().mockResolvedValue(null),
    getMetadata: vi.fn().mockResolvedValue({}),
  });
  return {
    caller,
    wire: { close: vi.fn() },
    events: testEventSource(),
    dispose: vi.fn(),
  } as unknown as InterfaceClient;
}

function appServices(overrides: Partial<AppServices> = {}): AppServices {
  return {
    createConnection: vi.fn(),
    deleteConnection: vi.fn(),
    install: vi.fn().mockResolvedValue({ kind: 'not-installed' }),
    teardown: vi.fn().mockResolvedValue(installed),
    ...overrides,
  } as unknown as AppServices;
}

describe('root App', () => {
  it('transitions from Install to Teardown after install returns an installed projection', async () => {
    const services = appServices({ install: vi.fn().mockResolvedValue(installed) });
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce(notInstalled)
      .mockResolvedValueOnce({ installation: installed, connectionCount: 0 });
    render(<App client={rootClient()} services={services} loadDashboard={loadDashboard} />);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: /install postgresql/i }));
    expect(services.install).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: /teardown postgresql/i })).toBeVisible();
  });

  it('opens an in-app teardown dialog and cancellation starts no run', async () => {
    const client = rootClient();
    const services = appServices({
      teardown: vi.fn(async (deps) => {
        const confirmed = await deps.requestConfirmation('Teardown PostgreSQL?');
        if (!confirmed) return installed;
        deps.onProgress({ phase: 'starting', runId: null });
        return { kind: 'not-installed' as const };
      }),
    });
    render(<App client={client} services={services} loadDashboard={vi.fn().mockResolvedValue(installedDashboard)} />);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: /teardown postgresql/i }));
    expect(screen.getByRole('dialog', { name: /teardown postgresql/i })).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /cancel/i }));
    expect(client.caller.start).not.toHaveBeenCalled();
  });

  it('never calls browser confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    render(
      <App
        client={rootClient()}
        services={appServices()}
        loadDashboard={vi.fn().mockResolvedValue(installedDashboard)}
      />,
    );
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: /teardown postgresql/i }));
    expect(confirm).not.toHaveBeenCalled();
  });
});
