import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { RPCCaller, Wire } from '@ezenki/deploy-commander-installer-interface';
import App, { type AppClientFactory } from './App';
import { createRunEventSource } from './lib/runMonitor';
import { recoverConnectionOnBoot, type AppClient } from './lib/appRecovery';
import { databaseResult } from './test/databaseQuery';
import * as installationLifecycle from './lib/installationLifecycle';

afterEach(() => cleanup());

const operation = {
  kind: 'connection', operation_id: 'operation-1', caller_id: 'manager-2', resource_id: 'resource-1',
  database: 'db_0123456789abcdef0123456789abcdef', username: 'pg_user_0123456789abcdef0123456789abcdef',
  phase: 'provision-running', cleanup_reason: 'provision-failed', provision_run_id: 'provision-run',
  cleanup_run_id: null, created_at: '2026-08-30T00:00:00.000Z', updated_at: '2026-08-30T00:00:00.000Z',
};
const primary = {
  phase: 'ready', operation_id: 'primary-1', admin_username: 'pg_admin_0123456789abcdef0123456789abcdef',
  admin_password: 'admin-password', run_id: 'install-run', resource_id: 'resource-1',
  initialized_at: '2026-08-30T00:00:00.000Z', updated_at: '2026-08-30T00:00:00.000Z',
};

function client(phase: string): AppClient {
  const caller = {
    databaseQuery: vi.fn().mockImplementation(async (query: string) => {
      if (query.startsWith('SELECT kind')) return databaseResult([{ ...operation, phase }]);
      if (query.startsWith('SELECT phase')) return databaseResult([primary]);
      return databaseResult(['operation-1']);
    }),
    getMyResources: vi.fn().mockResolvedValue({ items: [{ id: 'resource-1', type: 'postgres', name: 'postgres', external: false }], limit: 50, offset: 0, total: 1 }),
    getResource: vi.fn().mockResolvedValue({ config: { platform_connection: { type: 'Platform', data: { network: 'postgres-network' } } }, resource: {} }),
    getConnections: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    getRun: vi.fn().mockImplementation(async (id: string) => ({ run: { id, status: id === 'provision-run' ? 1 : 2 } })),
    start: vi.fn().mockResolvedValue({ id: 'cleanup-run', queued_at: 'now', status: 0 }),
  } as unknown as RPCCaller;
  return { caller, wire: {} as AppClient['wire'], events: createRunEventSource() };
}

describe('App boot recovery call site', () => {
  it('blocks new dashboard work while a provisioning journal has an active run', async () => {
    const current = client('provision-running');
    await expect(recoverConnectionOnBoot(current)).resolves.toEqual({ kind: 'busy' });
    expect(current.caller.start).not.toHaveBeenCalled();
  });

  it('runs recorded cleanup during boot and releases the journal after success', async () => {
    const current = client('cleanup-required');
    await expect(recoverConnectionOnBoot(current)).resolves.toEqual({ kind: 'retry' });
    expect(current.caller.start).toHaveBeenCalledWith(
      'cleanup-connection', 'ezenki/deploy-commander-runner:latest', expect.anything(), 'postgres-cleanup:operation-1',
    );
  });
});

function appClient(overrides: Partial<RPCCaller> = {}, metadata: unknown = {}) {
  const wire = { close: vi.fn(), end: vi.fn() } as unknown as Wire;
  const caller = {
    getManager: vi.fn().mockResolvedValue('postgres-manager'),
    getMetadata: vi.fn().mockResolvedValue(metadata),
    getCallingManager: vi.fn().mockResolvedValue('calling-manager'),
    getMyResources: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    databaseQuery: vi.fn().mockResolvedValue(databaseResult([])),
    ...overrides,
  } as unknown as RPCCaller;
  return { caller, wire, events: createRunEventSource() };
}

const STATE_DEFINITION =
  'DEFINE TABLE IF NOT EXISTS postgres_state SCHEMALESS;';
const OPERATION_DEFINITION =
  'DEFINE TABLE IF NOT EXISTS postgres_operation SCHEMALESS;';

const databaseError = {
  results: [{ statement: 0, status: 'ERR', time: '1ms', result: 'private detail' }],
};

describe('App lifecycle and resource routing', () => {
  it('renders initial loading inside the manager shell', () => {
    const current = appClient({
      getManager: vi.fn().mockReturnValue(new Promise(() => undefined)),
    });

    render(<App createClient={() => current} />);
    expect(screen.getByRole('heading', { name: 'PostgreSQL manager' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Loading manager state');
  });

  it('renders fatal storage failure once in the manager shell', async () => {
    const current = appClient({
      databaseQuery: vi.fn().mockResolvedValue({
        results: [{ statement: 0, status: 'ERR', time: '1ms', result: 'private' }],
      }),
    });

    render(<App createClient={() => current} />);
    expect(await screen.findByRole('heading', {
      name: 'Manager storage is unavailable',
    })).toBeVisible();
    expect(screen.getAllByText('Unable to initialize PostgreSQL manager storage'))
      .toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(screen.queryByText('private')).not.toBeInTheDocument();
  });

  it('initializes both tables before the first recovery read', async () => {
    const queries: string[] = [];
    const current = appClient({
      databaseQuery: vi.fn().mockImplementation(async (query: string) => {
        queries.push(query);
        return databaseResult([]);
      }),
    });

    render(<App createClient={() => current} />);
    await screen.findByRole('button', { name: 'Install PostgreSQL' });

    expect(queries.slice(0, 2)).toEqual([STATE_DEFINITION, OPERATION_DEFINITION]);
    expect(queries.findIndex((query) => query.startsWith('SELECT'))).toBeGreaterThan(1);
  });

  it('initializes both tables before the first child recovery read', async () => {
    const queries: string[] = [];
    const current = appClient({
      getCallingManager: vi.fn().mockResolvedValue('calling-manager'),
      getMyResources: vi.fn().mockResolvedValue({
        items: [{ id: 'resource-1', type: 'postgres', name: 'postgres', external: false }],
        limit: 50, offset: 0, total: 1,
      }),
      databaseQuery: vi.fn().mockImplementation(async (query: string) => {
        queries.push(query);
        if (query.startsWith('SELECT phase')) return databaseResult([primary]);
        return databaseResult([]);
      }),
    }, { action: 'create-connection' });

    render(<App createClient={() => current} />);
    await waitFor(() => expect(queries.some((query) => query.startsWith('SELECT kind'))).toBe(true));

    const firstRecoveryRead = queries.findIndex((query) => query.startsWith('SELECT kind'));
    expect(firstRecoveryRead).toBeGreaterThan(1);
    expect(queries.slice(0, firstRecoveryRead)).toEqual([STATE_DEFINITION, OPERATION_DEFINITION]);
  });

  it('shows a fixed retryable storage error in root mode', async () => {
    let stateDefinitions = 0;
    const current = appClient({
      databaseQuery: vi.fn().mockImplementation(async (query: string) => {
        if (query === STATE_DEFINITION && stateDefinitions++ === 0) return databaseError;
        return databaseResult([]);
      }),
    });
    const factory = vi.fn(() => current);

    render(<App createClient={factory} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to initialize PostgreSQL manager storage',
    );
    expect(screen.queryByText('private detail')).not.toBeInTheDocument();

    screen.getByRole('button', { name: 'Retry' }).click();
    await screen.findByRole('button', { name: 'Install PostgreSQL' });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(current.wire.end).not.toHaveBeenCalled();
  });

  it('closes child mode once with 503 when storage initialization fails', async () => {
    const current = appClient({
      databaseQuery: vi.fn().mockResolvedValue(databaseError),
    }, { action: 'create-connection' });

    render(<App createClient={() => current} />);
    await waitFor(() => expect(current.wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { status: 503, message: 'PostgreSQL recovery is required' },
    }));
    expect(current.wire.close).toHaveBeenCalledTimes(1);
  });

  it('rejects the obsolete object manager shape without logging it', async () => {
    const current = appClient({
      getManager: vi.fn().mockResolvedValue({ id: 'obsolete-manager-shape' }),
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    render(<App createClient={() => current} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to identify the PostgreSQL manager',
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('maps unexpected boot errors to a fixed safe message', async () => {
    const current = appClient({
      getMetadata: vi.fn().mockRejectedValue(new Error('private backend detail')),
    });

    render(<App createClient={() => current} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load PostgreSQL manager state',
    );
    expect(screen.queryByText('private backend detail')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Manager startup requires attention' })).toBeInTheDocument();
  });

  it('offers a confirmed teardown retry after a terminal teardown failure', async () => {
    vi.spyOn(installationLifecycle, 'teardownPostgres').mockRejectedValue(new Error('PostgreSQL teardown failed'));
    const current = appClient({
      getMyResources: vi.fn().mockResolvedValue({ items: [{ id: 'resource-1', type: 'postgres', name: 'postgres', external: false }], limit: 50, offset: 0, total: 1 }),
      databaseQuery: vi.fn().mockImplementation(async (query: string) => {
        if (query.startsWith('SELECT phase')) return databaseResult([primary]);
        return databaseResult([]);
      }),
    });

    render(<App createClient={() => current} />);
    await screen.findByRole('heading', { name: 'PostgreSQL is installed' });
    screen.getByRole('button', { name: 'Teardown PostgreSQL' }).click();
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Teardown PostgreSQL?' })).toBeVisible());
    screen.getByRole('button', { name: 'Confirm teardown' }).click();

    expect(await screen.findByRole('button', { name: 'Retry teardown' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry recovery' })).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'Retry teardown' }).click();
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Teardown PostgreSQL?' })).toBeVisible());
  });

  it('aborts an in-flight lifecycle wait when the app unmounts', async () => {
    let actionSignal: AbortSignal | undefined;
    vi.spyOn(installationLifecycle, 'installPostgres').mockImplementation(
      async ({ signal }) => {
        actionSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      },
    );
    const current = appClient();
    const view = render(<App createClient={() => current} />);
    await screen.findByRole('button', { name: 'Install PostgreSQL' });

    screen.getByRole('button', { name: 'Install PostgreSQL' }).click();
    await waitFor(() => expect(actionSignal).toBeDefined());
    view.unmount();

    expect(actionSignal?.aborted).toBe(true);
  });

  it('clears a failed lifecycle action after a successful recovery refresh', async () => {
    vi.spyOn(installationLifecycle, 'installPostgres')
      .mockRejectedValueOnce(new Error('private runner detail'))
      .mockResolvedValueOnce(undefined);
    const current = appClient();
    render(<App createClient={() => current} />);
    await screen.findByRole('button', { name: 'Install PostgreSQL' });

    screen.getByRole('button', { name: 'Install PostgreSQL' }).click();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to complete PostgreSQL lifecycle action',
    );

    screen.getByRole('button', { name: 'Retry recovery' }).click();
    await screen.findByRole('button', { name: 'Install PostgreSQL' });
    expect(screen.queryByText('Unable to complete PostgreSQL lifecycle action')).not.toBeInTheDocument();
  });

  it('keeps installation retryable after a confirmed installation failure', async () => {
    vi.spyOn(installationLifecycle, 'installPostgres')
      .mockRejectedValue(new Error('PostgreSQL installation failed'));
    const current = appClient();
    render(<App createClient={() => current} />);
    await screen.findByRole('button', { name: 'Install PostgreSQL' });

    screen.getByRole('button', { name: 'Install PostgreSQL' }).click();
    expect(await screen.findByRole('heading', { name: 'PostgreSQL installation failed' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Install PostgreSQL' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry recovery' })).not.toBeInTheDocument();
  });

  it('uses resource and private state instead of unrelated run events', async () => {
    const client = appClient();
    const factory: AppClientFactory = () => client;
    render(<App createClient={factory} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install PostgreSQL' })).toBeInTheDocument());
    client.events.publish({ eventType: 'run-start', event: 'event', data: { id: 'other-run', manager: 'other', action: 'create' } } as never);
    expect(screen.getByRole('button', { name: 'Install PostgreSQL' })).toBeInTheDocument();
  });

  it('fails closed when private primary state is unresolved', async () => {
    const client = appClient({ databaseQuery: vi.fn().mockImplementation(async (query: string) => databaseResult(query.startsWith('SELECT phase') ? [{
        phase: 'install-running', operation_id: 'op', admin_username: 'admin', admin_password: 'secret',
        run_id: 'run', resource_id: 'resource', initialized_at: null, updated_at: 'now',
      }] : [])) });
    render(<App createClient={() => client} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('recovery is required'));
  });

  it('fails closed for multiple exact resources even with stale state', async () => {
    const resources = [{ id: 'r1', type: 'postgres', name: 'postgres', external: false }, { id: 'r2', type: 'postgres', name: 'postgres', external: false }];
    const client = appClient({ getMyResources: vi.fn().mockResolvedValue({ items: resources, limit: 50, offset: 0, total: 2 }) });
    render(<App createClient={() => client} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('ambiguous'));
  });

  it('closes child mode through the wire when boot cannot find an installation', async () => {
    const client = appClient({}, { action: 'create-connection' });
    render(<App createClient={() => client} />);
    await waitFor(() => expect(client.wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager', ok: false,
      error: { status: 503, message: 'PostgreSQL recovery is required' },
    }));
  });
});
