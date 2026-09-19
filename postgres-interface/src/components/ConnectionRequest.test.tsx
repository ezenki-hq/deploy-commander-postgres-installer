import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RPCCaller, RPC, Wire } from '@ezenki/deploy-commander-installer-interface';
import ConnectionRequest from './ConnectionRequest';
import { createRunEventSource } from '../lib/runMonitor';

afterEach(cleanup);

const resource = {
  id: 'resource-1',
  type: 'postgres',
  name: 'postgres',
  external: false,
  manager: 'postgres-manager',
  agent: 'agent',
  created_at: 'now',
  updated_at: 'now',
} as RPC.ResourceItem;

function baseProps(caller: RPCCaller, wire: Wire) {
  return {
    caller,
    wire,
    events: createRunEventSource(),
    currentManagerId: 'postgres-manager',
    resource,
  };
}

const administrator = {
  username: 'dc_admin_0123456789abcdef0123456789abcdef',
  password: 'admin-password',
};

function installedCaller() {
  const caller = {
    getMyResources: vi
      .fn()
      .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
    getResource: vi.fn().mockResolvedValue({
      resource,
      config: {
        id: resource.id,
        manager: resource.manager,
        agent: resource.agent,
        resource_type: 'postgres',
        name: 'postgres',
        metadata: { engine: 'postgres', version: '15', administrator },
        platform_connection: { type: 'Platform', data: { network: 'postgres-network' } },
      },
    }),
    databaseQuery: vi
      .fn()
      .mockResolvedValue({ results: [{ status: 'OK', result: [{ name: 'orders' }] }] }),
    getRuns: vi.fn((...args: unknown[]) =>
      Promise.resolve({
        items: [],
        limit: typeof args[4] === 'number' ? args[4] : 1,
        offset: typeof args[5] === 'number' ? args[5] : 0,
        total: 0,
      }),
    ),
    getConnections: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    getCallingManager: vi.fn().mockResolvedValue('consumer-manager'),
    start: vi.fn().mockRejectedValue(new Error('transport unavailable')),
  } as unknown as RPCCaller;
  return caller;
}

describe('ConnectionRequest child errors', () => {
  it.each([
    ['A calling manager is required', 400, 'A calling manager is required'],
    [
      'A PostgreSQL operation is already in progress',
      409,
      'A PostgreSQL operation is already in progress',
    ],
    ['Database access was cancelled', 499, 'Database access was cancelled'],
    ['PostgreSQL recovery is required', 503, 'PostgreSQL recovery is required'],
  ])('keeps %s visible until the user rejects it', async (error, status, message) => {
    const user = userEvent.setup();
    const wire = { close: vi.fn() } as unknown as Wire;

    render(<ConnectionRequest {...baseProps({} as RPCCaller, wire)} initialError={error} />);

    expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(wire.close).toHaveBeenCalledWith({
        manager: 'postgres-manager',
        ok: false,
        error: { status, message },
      }),
    );
  });

  it('maps unexpected errors to a fixed non-secret 500 response', async () => {
    const user = userEvent.setup();
    const wire = { close: vi.fn() } as unknown as Wire;

    render(
      <ConnectionRequest
        {...baseProps({} as RPCCaller, wire)}
        initialError="database password is secret-in-the-error"
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(wire.close).toHaveBeenCalledWith({
        manager: 'postgres-manager',
        ok: false,
        error: { status: 500, message: 'Unable to create the PostgreSQL connection' },
      }),
    );
  });

  it('maps an invalid authoritative platform connection to recovery-required', async () => {
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {
      getCallingManager: vi.fn().mockResolvedValue('consumer-manager'),
      getResource: vi.fn().mockResolvedValue({
        config: { platform_connection: { type: 'Platform', data: { network: '' } } },
      }),
    } as unknown as RPCCaller;

    render(<ConnectionRequest {...baseProps(caller, wire)} />);

    expect(await screen.findByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/calling manager|required/i);
  });

  it('shows a blocked gate instead of progress-only UI for initial errors', () => {
    const wire = { close: vi.fn() } as unknown as Wire;
    render(
      <ConnectionRequest
        {...baseProps({} as RPCCaller, wire)}
        initialError="Invalid PostgreSQL connection request"
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid PostgreSQL connection request');
  });

  it('keeps the gate visible while caller lookup is pending', async () => {
    let resolveCaller: (value: string | null) => void = () => undefined;
    const callerRequest = new Promise<string | null>((resolve) => {
      resolveCaller = resolve;
    });
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {
      getCallingManager: vi.fn().mockReturnValue(callerRequest),
      start: vi.fn(),
    } as unknown as RPCCaller;
    render(<ConnectionRequest {...baseProps(caller, wire)} />);
    expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible();
    expect(screen.getByRole('dialog')).toHaveTextContent('Identifying the calling manager');
    expect(caller.start).not.toHaveBeenCalled();
    resolveCaller('consumer-manager');
  });

  it('closes once when rejecting pending preparation', async () => {
    const user = userEvent.setup();
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {
      getCallingManager: vi.fn().mockResolvedValue('consumer-manager'),
      getMyResources: vi.fn().mockReturnValue(new Promise(() => undefined)),
      start: vi.fn(),
    } as unknown as RPCCaller;
    render(<ConnectionRequest {...baseProps(caller, wire)} />);
    await screen.findByRole('dialog', { name: 'Approve PostgreSQL access?' });
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(caller.start).not.toHaveBeenCalled();
    await waitFor(() => expect(wire.close).toHaveBeenCalledTimes(1));
    expect(wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { status: 499, message: 'Database access was cancelled' },
    });
  });
});

describe('ConnectionRequest lifecycle', () => {
  it('passes complete metadata to the approval dialog and displays its superuser warning', async () => {
    const caller = installedCaller();
    const wire = { close: vi.fn() } as unknown as Wire;

    render(
      <ConnectionRequest
        {...baseProps(caller, wire)}
        metadata={{
          access: { scope: 'full', superuser: true },
          labels: { team: 'payments' },
        }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible(),
    );
    expect(screen.getByText('Dedicated superuser')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/every database/i);
    expect(screen.getByText('team=payments')).toBeVisible();
  });

  it('resolves approval with the configured access and sends it to the runner', async () => {
    const user = userEvent.setup();
    const caller = installedCaller();
    const wire = { close: vi.fn() } as unknown as Wire;

    render(
      <ConnectionRequest
        {...baseProps(caller, wire)}
        metadata={{ access: null, labels: { team: 'payments' } }}
      />,
    );

    await screen.findByRole('button', { name: 'Approve connection' });
    await user.click(screen.getByRole('radio', { name: /full access/i }));
    const approve = screen.getByRole('button', { name: 'Approve connection' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    await waitFor(() =>
      expect(caller.start).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'create-connection' }),
      ),
    );
    const options = (caller.start as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) =>
        call[0] &&
        typeof call[0] === 'object' &&
        (call[0] as { action?: string }).action === 'create-connection',
    )?.[0] as { metadata: { connections: { create: Array<{ metadata: unknown }> } } };
    expect(options.metadata.connections.create[0].metadata).toEqual(
      expect.objectContaining({
        access: { scope: 'full', superuser: false },
      }),
    );
  });

  it('returns 499 on rejection and requires a fresh decision for a second request', async () => {
    const user = userEvent.setup();
    const firstCaller = installedCaller();
    const firstWire = { close: vi.fn() } as unknown as Wire;
    const props = {
      ...baseProps(firstCaller, firstWire),
      metadata: {
        access: { scope: 'database' as const, operation: 'existing' as const, database: 'orders' },
        labels: {},
      },
    };
    const view = render(<ConnectionRequest {...props} />);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(firstWire.close).toHaveBeenCalledWith({
        manager: 'postgres-manager',
        ok: false,
        error: { status: 499, message: 'Database access was cancelled' },
      }),
    );

    view.unmount();
    const secondCaller = installedCaller();
    const secondWire = { close: vi.fn() } as unknown as Wire;
    render(
      <ConnectionRequest {...baseProps(secondCaller, secondWire)} metadata={props.metadata} />,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
    expect(secondWire.close).not.toHaveBeenCalled();
  });

  it('shows the approval gate while preflight is pending and starts no run', async () => {
    const wire = { close: vi.fn() } as unknown as Wire;
    const resourceRequest = new Promise(() => undefined);
    const caller = {
      getMyResources: vi.fn().mockResolvedValue({
        items: [resource],
        limit: 50,
        offset: 0,
        total: 1,
      }),
      getResource: vi.fn().mockReturnValue(resourceRequest),
      getCallingManager: vi.fn().mockResolvedValue('consumer-manager'),
      start: vi.fn(),
    } as unknown as RPCCaller;

    render(<ConnectionRequest {...baseProps(caller, wire)} />);
    expect(screen.getByRole('heading', { name: 'PostgreSQL manager' })).toBeVisible();
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('Preparing PostgreSQL connection');
    expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible();
    expect(screen.getByRole('dialog')).toHaveTextContent(/identifying|checking PostgreSQL/i);
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
    expect(caller.start).not.toHaveBeenCalled();
  });

  it('does not restart an active creation flow when rerendered with the same request', async () => {
    let resolveResource: (value: unknown) => void = () => undefined;
    const resourceRequest = new Promise((resolve) => {
      resolveResource = resolve;
    });
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {
      getMyResources: vi
        .fn()
        .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      getResource: vi.fn().mockReturnValue(resourceRequest),
      getCallingManager: vi.fn().mockResolvedValue('consumer-manager'),
    } as unknown as RPCCaller;
    const props = baseProps(caller, wire);
    const view = render(<ConnectionRequest {...props} />);

    await waitFor(() => expect(caller.getResource).toHaveBeenCalledTimes(1));
    view.rerender(<ConnectionRequest {...props} />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(caller.getResource).toHaveBeenCalledTimes(1);
    view.unmount();
    resolveResource({
      resource,
      config: {
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
    });
  });

  it('closes an initial success exactly once across a rerender', async () => {
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {} as RPCCaller;
    const initialResult = {
      connection: { id: 'connection-1' },
      config: { metadata: {} },
    } as RPC.CreateConnection;
    const props = { ...baseProps(caller, wire), initialResult };
    const view = render(<ConnectionRequest {...props} />);

    await waitFor(() => expect(wire.close).toHaveBeenCalledTimes(1));
    view.rerender(<ConnectionRequest {...props} />);
    await waitFor(() => expect(wire.close).toHaveBeenCalledTimes(1));
  });

  it('does not close after an in-flight request is unmounted', async () => {
    let resolveResource: (value: unknown) => void = () => undefined;
    const resourceRequest = new Promise((resolve) => {
      resolveResource = resolve;
    });
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {
      getMyResources: vi
        .fn()
        .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      getResource: vi.fn().mockReturnValue(resourceRequest),
      getCallingManager: vi.fn().mockResolvedValue('consumer-manager'),
    } as unknown as RPCCaller;
    const view = render(<ConnectionRequest {...baseProps(caller, wire)} />);

    view.unmount();
    resolveResource({
      resource,
      config: {
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
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(wire.close).not.toHaveBeenCalled();
  });
});
