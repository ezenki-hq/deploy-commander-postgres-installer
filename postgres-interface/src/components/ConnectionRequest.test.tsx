import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { RPCCaller, RPC, Wire } from '@ezenki/deploy-commander-installer-interface';
import ConnectionRequest from './ConnectionRequest';
import { createRunEventSource } from '../lib/runMonitor';

afterEach(cleanup);

const resource = {
  id: 'resource-1', type: 'postgres', name: 'postgres', external: false,
  manager: 'postgres-manager', agent: 'agent', created_at: 'now', updated_at: 'now',
} as RPC.ResourceItem;

function baseProps(caller: RPCCaller, wire: Wire) {
  return {
    caller,
    wire,
    events: createRunEventSource(),
    currentManagerId: 'postgres-manager',
    callingManagerId: 'consumer-manager',
    resource,
    storage: {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    } as unknown as Storage,
  };
}

describe('ConnectionRequest child errors', () => {
  it.each([
    ['A calling manager is required', 400, 'A calling manager is required'],
    ['A PostgreSQL operation is already in progress', 409, 'A PostgreSQL operation is already in progress'],
    ['Database access was cancelled', 499, 'Database access was cancelled'],
    ['PostgreSQL recovery is required', 503, 'PostgreSQL recovery is required'],
  ])('maps %s to a fixed non-secret response', async (error, status, message) => {
    const wire = { close: vi.fn() } as unknown as Wire;

    render(<ConnectionRequest
      {...baseProps({} as RPCCaller, wire)}
      initialError={error}
    />);

    await waitFor(() => expect(wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { status, message },
    }));
  });

  it('maps unexpected errors to a fixed non-secret 500 response', async () => {
    const wire = { close: vi.fn() } as unknown as Wire;

    render(<ConnectionRequest
      {...baseProps({} as RPCCaller, wire)}
      initialError="database password is secret-in-the-error"
    />);

    await waitFor(() => expect(wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { status: 500, message: 'Unable to create the PostgreSQL connection' },
    }));
  });

  it('maps an invalid authoritative platform connection to recovery-required', async () => {
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {
      getResource: vi.fn().mockResolvedValue({
        config: { platform_connection: { type: 'Platform', data: { network: '' } } },
      }),
    } as unknown as RPCCaller;

    render(<ConnectionRequest {...baseProps(caller, wire)} />);

    await waitFor(() => expect(wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { status: 503, message: 'PostgreSQL recovery is required' },
    }));
  });
});

describe('ConnectionRequest lifecycle', () => {
  it('presents preparation in the PostgreSQL manager shell', () => {
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {
      getResource: vi.fn().mockReturnValue(new Promise(() => undefined)),
    } as unknown as RPCCaller;

    render(<ConnectionRequest {...baseProps(caller, wire)} />);
    expect(screen.getByRole('heading', { name: 'PostgreSQL manager' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Preparing PostgreSQL connection');
  });

  it('does not restart an active creation flow when rerendered with the same request', async () => {
    let resolveResource: (value: unknown) => void = () => undefined;
    const resourceRequest = new Promise((resolve) => { resolveResource = resolve; });
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {
      getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      getResource: vi.fn().mockReturnValue(resourceRequest),
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
          engine: 'postgres', version: '15',
          administrator: { username: 'dc_admin_0123456789abcdef0123456789abcdef', password: 'admin-password' },
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
    const resourceRequest = new Promise((resolve) => { resolveResource = resolve; });
    const wire = { close: vi.fn() } as unknown as Wire;
    const caller = {
      getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
      getResource: vi.fn().mockReturnValue(resourceRequest),
    } as unknown as RPCCaller;
    const view = render(<ConnectionRequest {...baseProps(caller, wire)} />);

    view.unmount();
    resolveResource({
      resource,
      config: {
        metadata: {
          engine: 'postgres', version: '15',
          administrator: { username: 'dc_admin_0123456789abcdef0123456789abcdef', password: 'admin-password' },
        },
        platform_connection: { type: 'Platform', data: { network: 'postgres-network' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(wire.close).not.toHaveBeenCalled();
  });
});
