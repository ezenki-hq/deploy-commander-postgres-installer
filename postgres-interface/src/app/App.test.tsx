import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppServices } from './App';
import App from './App';
import { PostgresRequestError } from '../domain/errors';
import type { DashboardProjection } from '../platform/dashboardProjection';
import type { InstallationProjection } from '../platform/resources';
import { deferred, fakeCaller, testEventSource } from '../test/fakes';
import type { InterfaceClient } from '../platform/interfaceClient';
import type { CreateApprovalContext } from '../workflows/createConnection';
import type { DeleteApprovalContext } from '../workflows/deleteConnection';

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

const createContext: CreateApprovalContext = {
  callingManagerId: 'consumer-1',
  requestedAccess: { scope: 'database', operation: 'create', database: 'orders' },
  callerLabels: {},
  databaseNames: ['orders'],
};
const deleteContext: DeleteApprovalContext = {
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
};

function childClient(metadata: Record<string, unknown>): InterfaceClient {
  const caller = fakeCaller({
    getManager: vi.fn().mockResolvedValue('postgres-manager'),
    getCallingManager: vi.fn().mockResolvedValue('consumer-1'),
    getMetadata: vi.fn().mockResolvedValue(metadata),
  });
  return {
    caller,
    wire: { close: vi.fn() },
    events: testEventSource(),
    dispose: vi.fn(),
  } as unknown as InterfaceClient;
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

describe('child App approval and failure states', () => {
  it('renders create approval before progress and starts nothing before Approve', async () => {
    const completion = deferred<RPC.CreateConnection>();
    const client = childClient({
      action: 'create-connection',
      scope: 'database',
      operation: 'create',
      database: 'orders',
    });
    const services = appServices({
      createConnection: vi.fn(async (deps) => {
        const decision = await deps.requestApproval(createContext);
        if (!decision.allowed)
          throw new PostgresRequestError(499, 'PostgreSQL connection request was cancelled');
        deps.onProgress?.({ phase: 'starting', runId: null });
        return completion.promise;
      }),
    });
    render(<App client={client} services={services} />);
    expect(
      await screen.findByRole('dialog', { name: /approve postgresql connection/i }),
    ).toBeVisible();
    expect(screen.queryByText(/starting postgresql operation/i)).not.toBeInTheDocument();
    expect(client.caller.start).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByText(/starting postgresql operation/i)).toBeVisible();
    const createdConnection = { connection: { id: 'connection-1' }, config: {} } as RPC.CreateConnection;
    completion.resolve(createdConnection);
    await waitFor(() =>
      expect(client.wire.close).toHaveBeenCalledWith({
        manager: 'postgres-manager',
        ok: true,
        result: createdConnection,
      }),
    );
  });

  it('renders delete approval before progress and starts nothing before Reject', async () => {
    const client = childClient({ action: 'delete-connection', connection: 'connection-1' });
    const services = appServices({
      deleteConnection: vi.fn(async (deps) => {
        const decision = await deps.requestApproval(deleteContext);
        if (!decision.allowed)
          throw new PostgresRequestError(499, 'PostgreSQL connection deletion was cancelled');
        throw new Error('test must not approve');
      }),
    });
    render(<App client={client} services={services} />);
    expect(
      await screen.findByRole('dialog', { name: /approve postgresql connection deletion/i }),
    ).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(client.caller.start).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: /^reject$/i }));
    await waitFor(() =>
      expect(client.wire.close).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, error: expect.objectContaining({ status: 499 }) }),
      ),
    );
  });

  it.each(['create-connection', 'delete-connection'] as const)(
    'rejects %s with 499 and zero starts',
    async (action) => {
      const client = childClient({ action });
      const services = appServices({
        createConnection:
          action === 'create-connection'
            ? vi.fn(async (deps) => {
                const decision = await deps.requestApproval(createContext);
                if (!decision.allowed)
                  throw new PostgresRequestError(499, 'PostgreSQL connection approval was rejected');
                throw new Error('test must not approve');
              })
            : vi.fn(),
        deleteConnection:
          action === 'delete-connection'
            ? vi.fn(async (deps) => {
                const decision = await deps.requestApproval(deleteContext);
                if (!decision.allowed)
                  throw new PostgresRequestError(499, 'PostgreSQL connection deletion was rejected');
                throw new Error('test must not approve');
              })
            : vi.fn(),
      });
      render(<App client={client} services={services} />);
      await userEvent.setup().click(await screen.findByRole('button', { name: /^reject$/i }));
      expect(client.caller.start).not.toHaveBeenCalled();
      expect(client.wire.close).toHaveBeenCalledWith({
        manager: 'postgres-manager',
        ok: false,
        error: { message: expect.any(String), status: 499 },
      });
    },
  );

  it('renders and closes a preflight failure instead of going blank', async () => {
    const client = childClient({ action: 'create-connection' });
    render(
      <App
        client={client}
        services={appServices({
          createConnection: vi
            .fn()
            .mockRejectedValue(new PostgresRequestError(404, 'PostgreSQL is not installed')),
        })}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('PostgreSQL is not installed');
    expect(client.wire.close).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ status: 404 }) }),
    );
  });

  it('closes invalid child actions with status 400', async () => {
    const client = childClient({ action: 'unsupported-action' });
    render(<App client={client} services={appServices()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/unsupported postgresql action/i);
    expect(client.wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { message: 'Unsupported PostgreSQL action', status: 400 },
    });
  });

  it('closes a successful delete with only the deleted connection id', async () => {
    const client = childClient({ action: 'delete-connection', connection: 'connection-1' });
    const services = appServices({
      deleteConnection: vi.fn(async (deps) => {
        const decision = await deps.requestApproval(deleteContext);
        if (!decision.allowed)
          throw new PostgresRequestError(499, 'PostgreSQL connection deletion was rejected');
        return { connection: decision.connectionId };
      }),
    });
    render(<App client={client} services={services} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: /^approve$/i }));
    await waitFor(() =>
      expect(client.wire.close).toHaveBeenCalledWith({
        manager: 'postgres-manager',
        ok: true,
        result: { connection: 'connection-1' },
      }),
    );
  });

  it('sanitizes unknown child errors', async () => {
    const client = childClient({ action: 'create-connection' });
    render(
      <App
        client={client}
        services={appServices({
          createConnection: vi.fn().mockRejectedValue(new Error('password=secret SELECT * FROM users')),
        })}
      />,
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('PostgreSQL manager operation failed');
    expect(alert).not.toHaveTextContent(/secret|password|select/i);
    expect(client.wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { message: 'PostgreSQL manager operation failed', status: 500 },
    });
  });

  it('disposes and resolves a pending approval on unmount', async () => {
    const client = childClient({ action: 'create-connection' });
    const services = appServices({
      createConnection: vi.fn(async (deps) => {
        const decision = await deps.requestApproval(createContext);
        if (!decision.allowed)
          throw new PostgresRequestError(499, 'PostgreSQL connection approval was rejected');
        throw new Error('test must not approve');
      }),
    });
    const view = render(<App client={client} services={services} />);
    expect(await screen.findByRole('dialog', { name: /approve postgresql connection/i })).toBeVisible();
    view.unmount();
    await waitFor(() => expect(client.wire.close).toHaveBeenCalled());
    expect(client.dispose).toHaveBeenCalledOnce();
  });
});
