import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { RPCCaller, RPC, Wire, Events } from '@ezenki/deploy-commander-installer-interface';
import App from './App';
import { createRunEventSource } from './lib/runMonitor';
import type { AppClient } from './lib/interfaceClient';

afterEach(cleanup);
const resource = { id: 'resource-1', type: 'postgres', name: 'postgres', external: false, manager: 'manager', created_at: 'now', updated_at: 'now' } as RPC.ResourceItem;
const run = (status: 0 | 1 | 2 | 3, action: 'create' | 'teardown' = 'create'): RPC.RunItem => ({ id: `run-${status}`, action, status, queued_at: 'now', created_at: 'now', updated_at: 'now' });
function fixture(overrides: Partial<RPCCaller> = {}, metadata: unknown = {}) {
  let onEvent: ((event: Events.InterfaceEvent) => void) | undefined;
  const caller = { getManager: vi.fn().mockResolvedValue('postgres-manager'), getMetadata: vi.fn().mockResolvedValue(metadata), getCallingManager: vi.fn().mockResolvedValue('caller-manager'), getRuns: vi.fn().mockResolvedValue({ items: [], limit: 1, offset: 0, total: 0 }), getMyResources: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }), getResource: vi.fn(), databaseQuery: vi.fn(() => { throw new Error('database must not be used'); }), ...overrides } as unknown as RPCCaller;
  const wire = { end: vi.fn(), close: vi.fn() } as unknown as Wire;
  const client: AppClient = { caller, wire, events: createRunEventSource() };
  const factory = vi.fn((callback: (event: Events.InterfaceEvent) => void) => { onEvent = callback; return client; });
  return { caller, wire, client, factory, publish: (event: Events.InterfaceEvent) => onEvent?.(event) };
}
describe('run-backed App boot', () => {
  it('reads the latest run and never initializes private database state', async () => {
    const current = fixture({ getRuns: vi.fn().mockResolvedValue({ items: [run(2)], limit: 1, offset: 0, total: 1 }), getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }), getResource: vi.fn().mockResolvedValue({ resource, config: { id: resource.id, manager: resource.manager, agent: 'agent', resource_type: 'postgres', name: 'postgres', metadata: { engine: 'postgres', version: '15', administrator: { username: 'dc_admin_0123456789abcdef0123456789abcdef', password: 'secret' } }, platform_connection: { type: 'Platform', data: { network: 'postgres-network' } } } }) });
    render(<App createClient={current.factory} />);
    await screen.findByRole('heading', { name: 'PostgreSQL is installed' });
    expect(current.caller.getRuns).toHaveBeenCalledWith(undefined, undefined, undefined, '-created_at', 1, 0);
    expect(current.caller.databaseQuery).not.toHaveBeenCalled();
  });
  it('renders connection mode without discovering a resource', async () => {
    const current = fixture({}, { action: 'create-connection' });
    render(<App createClient={current.factory} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Preparing PostgreSQL connection'));
  });
  it('refreshes latest lifecycle after a terminal run update', async () => {
    const getRuns = vi.fn().mockResolvedValueOnce({ items: [run(0)], limit: 1, offset: 0, total: 1 }).mockResolvedValue({ items: [run(2)], limit: 1, offset: 0, total: 1 });
    const current = fixture({ getRuns });
    render(<App createClient={current.factory} />);
    await screen.findByRole('status');
    current.publish({ eventType: 'run-update', event: 'event', data: { type: 'event', payload: { id: 'run-0', status: 2 } } } as never);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'PostgreSQL state needs recovery' })).toBeInTheDocument());
    expect(getRuns).toHaveBeenCalledTimes(2);
  });
  it('marks an installed run with no resource as contradiction attention', async () => {
    const current = fixture({ getRuns: vi.fn().mockResolvedValue({ items: [run(2)], limit: 1, offset: 0, total: 1 }) });
    render(<App createClient={current.factory} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'PostgreSQL state needs recovery' })).toBeVisible());
  });
  it('ends the stable wire on unmount', async () => { const current = fixture(); const view = render(<App createClient={current.factory} />); view.unmount(); await waitFor(() => expect(current.wire.end).toHaveBeenCalledOnce()); });
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
});
