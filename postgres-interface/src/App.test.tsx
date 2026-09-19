import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RPCCaller, RPC, Wire, Events } from '@ezenki/deploy-commander-installer-interface';
import App from './App';
import { createRunEventSource } from './lib/runMonitor';
import type { AppClient } from './lib/interfaceClient';

afterEach(cleanup);
const resource = {
  id: 'resource-1',
  type: 'postgres',
  name: 'postgres',
  external: false,
  manager: 'manager',
  created_at: 'now',
  updated_at: 'now',
} as RPC.ResourceItem;
const run = (status: 0 | 1 | 2 | 3, action: 'create' | 'teardown' = 'create'): RPC.RunItem => ({
  id: `run-${status}`,
  action,
  status,
  queued_at: 'now',
  created_at: 'now',
  updated_at: 'now',
});
function fixture(overrides: Partial<RPCCaller> = {}, metadata: unknown = {}) {
  let onEvent: ((event: Events.InterfaceEvent) => void) | undefined;
  const caller = {
    getManager: vi.fn().mockResolvedValue('postgres-manager'),
    getMetadata: vi.fn().mockResolvedValue(metadata),
    getCallingManager: vi.fn().mockResolvedValue('caller-manager'),
    getRuns: vi.fn().mockResolvedValue({ items: [], limit: 1, offset: 0, total: 0 }),
    getMyResources: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    getResource: vi.fn(),
    start: vi.fn(),
    databaseQuery: vi.fn(() => {
      throw new Error('database must not be used');
    }),
    ...overrides,
  } as unknown as RPCCaller;
  const wire = { end: vi.fn(), close: vi.fn() } as unknown as Wire;
  const client: AppClient = { caller, wire, events: createRunEventSource() };
  const factory = vi.fn((callback: (event: Events.InterfaceEvent) => void) => {
    onEvent = callback;
    return client;
  });
  return {
    caller,
    wire,
    client,
    factory,
    publish: (event: Events.InterfaceEvent) => onEvent?.(event),
  };
}
describe('run-backed App boot', () => {
  it('reads the latest run and never initializes private database state', async () => {
    const current = fixture({
      getRuns: vi.fn().mockResolvedValue({ items: [run(2)], limit: 1, offset: 0, total: 1 }),
      getMyResources: vi
        .fn()
        .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      getResource: vi.fn().mockResolvedValue({
        resource,
        config: {
          id: resource.id,
          manager: resource.manager,
          agent: 'agent',
          resource_type: 'postgres',
          name: 'postgres',
          metadata: {
            engine: 'postgres',
            version: '15',
            administrator: {
              username: 'dc_admin_0123456789abcdef0123456789abcdef',
              password: 'secret',
            },
          },
          platform_connection: { type: 'Platform', data: { network: 'postgres-network' } },
        },
      }),
    });
    render(<App createClient={current.factory} />);
    await screen.findByRole('heading', { name: 'PostgreSQL is installed' });
    expect(current.caller.getRuns).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      '-created_at',
      1,
      0,
    );
    expect(current.caller.databaseQuery).not.toHaveBeenCalled();
  });
  it('renders connection mode without discovering a resource', async () => {
    const current = fixture(
      { getCallingManager: vi.fn(() => new Promise(() => undefined)) },
      { action: 'create-connection' },
    );
    render(<App createClient={current.factory} />);
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible(),
    );
    expect(current.caller.getMyResources).not.toHaveBeenCalled();
  });
  it('shows create approval while caller lookup is pending', async () => {
    const current = fixture(
      { getCallingManager: vi.fn(() => new Promise(() => undefined)) },
      { action: 'create-connection', scope: 'database', operation: 'create', database: 'orders' },
    );
    render(<App createClient={current.factory} />);

    expect(
      await screen.findByRole('dialog', { name: 'Approve PostgreSQL access?' }),
    ).toBeVisible();
    expect(screen.getByRole('dialog')).toHaveTextContent('Identifying the calling manager');
    expect(current.caller.getMyResources).not.toHaveBeenCalled();
    expect(current.caller.start).not.toHaveBeenCalled();
  });
  it.each([
    ['missing', vi.fn().mockResolvedValue(null)],
    ['failed', vi.fn().mockRejectedValue(new Error('transport detail'))],
  ])('shows a blocked create approval when caller lookup is %s', async (_case, getCallingManager) => {
    const current = fixture(
      { getCallingManager },
      { action: 'create-connection', scope: 'database', operation: 'create', database: 'orders' },
    );
    render(<App createClient={current.factory} />);

    expect(
      await screen.findByRole('dialog', { name: 'Approve PostgreSQL access?' }),
    ).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent('A calling manager is required');
    expect(screen.queryByRole('button', { name: 'Approve connection' })).not.toBeInTheDocument();
    expect(current.caller.start).not.toHaveBeenCalled();
  });
  it('passes complete connection metadata into the approval flow', async () => {
    const current = fixture(
      {},
      {
        action: 'create-connection',
        scope: 'full',
        superuser: true,
        labels: { team: 'payments' },
      },
    );
    render(<App createClient={current.factory} />);
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible(),
    );
    await waitFor(() => expect(screen.getByText('Dedicated superuser')).toBeVisible());
    expect(screen.getByText('team=payments')).toBeVisible();
  });
  it('closes malformed connection metadata with a normalized 400', async () => {
    const current = fixture({}, { action: 'create-connection', scope: 'database' });
    render(<App createClient={current.factory} />);
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible(),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid PostgreSQL connection request');
    expect(current.caller.getCallingManager).not.toHaveBeenCalled();
    expect(current.caller.getMyResources).not.toHaveBeenCalled();
  });
  it('refreshes latest lifecycle after a terminal run update', async () => {
    const getRuns = vi
      .fn()
      .mockResolvedValueOnce({ items: [run(0)], limit: 1, offset: 0, total: 1 })
      .mockResolvedValue({ items: [run(2)], limit: 1, offset: 0, total: 1 });
    const current = fixture({ getRuns });
    render(<App createClient={current.factory} />);
    await screen.findByRole('status');
    current.publish({
      eventType: 'run-update',
      event: 'event',
      data: { type: 'event', payload: { id: 'run-0', status: 2 } },
    } as never);
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'PostgreSQL state needs recovery' }),
      ).toBeInTheDocument(),
    );
    expect(getRuns).toHaveBeenCalledTimes(2);
  });
  it('keeps an approved child workflow stable across run events', async () => {
    const connection = {
      connection: {
        id: 'connection-1',
        manager: 'caller-manager',
        resource: resource.id,
        external: false,
        created_at: 'now',
        updated_at: 'now',
        labels: { team: 'payments', 'postgres.access': 'database', 'postgres.database': 'orders' },
      },
      config: {
        id: 'connection-1',
        manager: 'caller-manager',
        resource: resource.id,
        metadata: {
          host: 'postgres',
          port: 5432,
          database: 'orders',
          username: 'dc_user_0123456789abcdef0123456789abcdef',
          password: 'secret',
          platform_connection: { type: 'Platform', data: { network: 'postgres-network' } },
          access: { scope: 'database', operation: 'create', database: 'orders' },
        },
      },
    };
    const current = fixture(
      {
        getMyResources: vi
          .fn()
          .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
        getResource: vi.fn().mockResolvedValue({
          resource,
          config: {
            id: resource.id,
            manager: resource.manager,
            agent: 'agent',
            resource_type: 'postgres',
            name: 'postgres',
            metadata: {
              engine: 'postgres',
              version: '15',
              administrator: {
                username: 'dc_admin_0123456789abcdef0123456789abcdef',
                password: 'secret',
              },
            },
            platform_connection: { type: 'Platform', data: { network: 'postgres-network' } },
          },
        }),
        databaseQuery: vi.fn().mockResolvedValue({ results: [{ status: 'OK', result: [] }] }),
        getConnections: vi
          .fn()
          .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
          .mockResolvedValue({ items: [connection.connection], limit: 50, offset: 0, total: 1 }),
        getConnection: vi.fn().mockResolvedValue(connection),
        start: vi.fn().mockResolvedValue({ id: 'connection-run' }),
        getRun: vi.fn().mockResolvedValue({ run: { id: 'connection-run', status: 2 } }),
      },
      {
        action: 'create-connection',
        scope: 'database',
        operation: 'create',
        database: 'orders',
        labels: { team: 'payments' },
      },
    );
    render(<App createClient={current.factory} />);
    await screen.findByRole('button', { name: 'Approve connection' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve connection' }));
    await waitFor(() => expect(current.caller.start).toHaveBeenCalledTimes(1));

    const startEvent = {
      eventType: 'run-start',
      event: 'event',
      data: { type: 'event', payload: { id: 'connection-run', status: 1 } },
    } as never;
    current.publish(startEvent);
    current.client.events.publish({
      eventType: 'run-update',
      event: 'event',
      data: { type: 'event', payload: { id: 'connection-run', status: 2 } },
    } as never);
    await waitFor(() =>
      expect(current.wire.close).toHaveBeenCalledWith(expect.objectContaining({ ok: true })),
    );
    expect(current.caller.getMetadata).toHaveBeenCalledTimes(1);
    expect(current.caller.start).toHaveBeenCalledTimes(1);
  });
  it('marks an installed run with no resource as contradiction attention', async () => {
    const current = fixture({
      getRuns: vi.fn().mockResolvedValue({ items: [run(2)], limit: 1, offset: 0, total: 1 }),
    });
    render(<App createClient={current.factory} />);
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'PostgreSQL state needs recovery' }),
      ).toBeVisible(),
    );
  });
  it('ends the stable wire on unmount', async () => {
    const current = fixture();
    const view = render(<App createClient={current.factory} />);
    view.unmount();
    await waitFor(() => expect(current.wire.end).toHaveBeenCalledOnce());
  });
  it('ends the old wire and creates a replacement when the client factory changes', async () => {
    const first = fixture();
    const second = fixture();
    const view = render(<App createClient={first.factory} />);
    await waitFor(() => expect(first.factory).toHaveBeenCalledOnce());
    view.rerender(<App createClient={second.factory} />);
    await waitFor(() => expect(second.factory).toHaveBeenCalledOnce());
    expect(first.wire.end).toHaveBeenCalledOnce();
    view.unmount();
    await waitFor(() => expect(second.wire.end).toHaveBeenCalledOnce());
  });

  it('routes exact delete metadata without entering the dashboard', async () => {
    const connection = {
      connection: {
        id: 'connection-1',
        manager: 'caller-manager',
        resource: resource.id,
        external: false,
        created_at: 'now',
        updated_at: 'now',
        labels: { 'postgres.access': 'database', 'postgres.database': 'orders' },
      },
      config: {
        id: 'connection-1',
        manager: 'caller-manager',
        resource: resource.id,
        metadata: {
          host: 'postgres',
          port: 5432,
          database: 'orders',
          username: 'dc_user_0123456789abcdef0123456789abcdef',
          password: 'logical-password',
          access: { scope: 'database', operation: 'create', database: 'orders' },
          platform_connection: { type: 'Platform', data: { network: 'postgres-network' } },
        },
      },
    };
    const current = fixture(
      {
        getMyResources: vi
          .fn()
          .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
        getResource: vi.fn().mockResolvedValue({
          resource,
          config: {
            id: resource.id,
            manager: resource.manager,
            agent: 'agent',
            resource_type: 'postgres',
            name: 'postgres',
            metadata: {
              engine: 'postgres',
              version: '15',
              administrator: {
                username: 'dc_admin_0123456789abcdef0123456789abcdef',
                password: 'admin-password',
              },
            },
            platform_connection: { type: 'Platform', data: { network: 'postgres-network' } },
          },
        }),
        getConnections: vi
          .fn()
          .mockResolvedValue({ items: [connection.connection], limit: 50, offset: 0, total: 1 }),
        getConnection: vi.fn().mockResolvedValue(connection),
      },
      { action: 'delete-connection' },
    );
    render(<App createClient={current.factory} />);
    expect(await screen.findByRole('dialog', { name: 'Delete PostgreSQL connection?' })).toBeVisible();
    expect(current.caller.getCallingManager).toHaveBeenCalledOnce();
  });

  it('blocks malformed delete metadata with a normalized 400 before discovery', async () => {
    const current = fixture({}, { action: 'delete-connection', connection: '' });
    render(<App createClient={current.factory} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid PostgreSQL connection deletion request');
    expect(current.wire.close).not.toHaveBeenCalled();
    expect(current.caller.getMyResources).not.toHaveBeenCalled();
  });
});
