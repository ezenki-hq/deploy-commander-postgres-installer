import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RPCCaller, RPC, Wire } from '@ezenki/deploy-commander-installer-interface';
import DeleteConnectionRequest from './DeleteConnectionRequest';
import { createRunEventSource } from '../lib/runMonitor';
import type { AccessRequest } from '../lib/postgresConnectionRequest';
import { buildCleanupPlan } from '../lib/postgresPlans';
import { makeCleanupNote } from '../lib/connectionRuns';

afterEach(() => cleanup());
const resource: RPC.ResourceItem = {
  id: 'resource-1',
  type: 'postgres',
  name: 'postgres',
  manager: 'postgres-manager',
  external: false,
  agent: 'agent-1',
  created_at: 'now',
  updated_at: 'now',
};
const platform = { type: 'Platform' as const, data: { network: 'postgres-network' } };
const access: AccessRequest = { scope: 'database', operation: 'create', database: 'orders' };
const target = {
  connection: {
    id: 'connection-1',
    manager: 'consumer-manager',
    resource: resource.id,
    external: false,
    created_at: 'now',
    updated_at: 'now',
    labels: { 'postgres.access': 'database', 'postgres.database': 'orders' },
  },
  config: {
    id: 'connection-1',
    manager: 'consumer-manager',
    resource: resource.id,
    metadata: {
      host: 'postgres',
      port: 5432,
      database: 'orders',
      username: 'dc_user_0123456789abcdef0123456789abcdef',
      password: 'logical-password',
      access,
      platform_connection: platform,
    },
  },
};
function caller() {
  const metadata = buildCleanupPlan({
    administrator: {
      username: 'dc_admin_0123456789abcdef0123456789abcdef',
      password: 'admin-password',
    },
    login: { username: target.config.metadata.username, password: target.config.metadata.password },
    access,
    resourceId: resource.id,
    platform,
  });
  return {
    getMyResources: vi
      .fn()
      .mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
    getCallingManager: vi.fn().mockResolvedValue('consumer-manager'),
    getResource: vi.fn().mockResolvedValue({
      resource,
      config: {
        id: resource.id,
        manager: resource.manager,
        agent: resource.agent,
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
        platform_connection: platform,
      },
    }),
    getConnections: vi
      .fn()
      .mockResolvedValue({ items: [target.connection], limit: 50, offset: 0, total: 1 }),
    getConnection: vi.fn().mockResolvedValue(target),
    getRuns: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    start: vi.fn().mockResolvedValue({ id: 'cleanup-run', status: 0 }),
    getRun: vi.fn().mockResolvedValue({
      run: {
        id: 'cleanup-run',
        action: 'cleanup-connection',
        status: 2,
        note: makeCleanupNote({
          operationId: '01234567-89ab-4def-8123-456789abcdef',
          callerId: 'consumer-manager',
          resourceId: resource.id,
        }),
        queued_at: 'now',
        created_at: 'now',
        updated_at: 'now',
      },
      config: {
        id: 'cleanup-run',
        run: 'cleanup-run',
        action: 'cleanup-connection',
        manager: 'postgres-manager',
        runner: 'ezenki/deploy-commander-runner:latest',
        metadata,
      },
    }),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
  } as unknown as RPCCaller;
}
const base = (c: RPCCaller, wire: Wire) => ({
  caller: c,
  wire,
  events: createRunEventSource(),
  currentManagerId: 'postgres-manager',
  callingManagerId: 'consumer-manager',
  metadata: { connectionId: null as string | null },
});
describe('DeleteConnectionRequest', () => {
  it.each([
    ['A calling manager is required', 400, 'A calling manager is required'],
    [
      'Invalid PostgreSQL connection deletion request',
      400,
      'Invalid PostgreSQL connection deletion request',
    ],
    ['PostgreSQL connection was not found', 404, 'PostgreSQL connection was not found'],
    [
      'PostgreSQL connection changed during deletion',
      409,
      'PostgreSQL connection changed during deletion',
    ],
    [
      'PostgreSQL connection deletion was cancelled',
      499,
      'PostgreSQL connection deletion was cancelled',
    ],
    ['PostgreSQL recovery is required', 503, 'PostgreSQL recovery is required'],
  ] as const)('shows %s in the approval gate', async (error) => {
    const wire = { close: vi.fn() } as unknown as Wire;
    render(<DeleteConnectionRequest {...base({} as RPCCaller, wire)} initialError={error} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(error);
    expect(wire.close).not.toHaveBeenCalled();
  });
  it('shows the approval gate while ownership preflight is pending and starts no run', () => {
    const wire = { close: vi.fn() } as unknown as Wire;
    const pendingConnections = new Promise(() => undefined);
    const pendingCaller = caller();
    pendingCaller.getConnections = vi.fn().mockReturnValue(pendingConnections);

    render(
      <DeleteConnectionRequest
        {...base(pendingCaller, wire)}
        metadata={{ connectionId: 'connection-1' }}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Delete PostgreSQL connection?' })).toBeVisible();
    expect(screen.getByRole('dialog')).toHaveTextContent(/checking connection ownership/i);
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
    expect(pendingCaller.start).not.toHaveBeenCalled();
  });
  it('closes with only the deleted id', async () => {
    const wire = { close: vi.fn() } as unknown as Wire;
    const user = userEvent.setup();
    render(
      <DeleteConnectionRequest
        {...base(caller(), wire)}
        metadata={{ connectionId: 'connection-1' }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Delete connection' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    await waitFor(() =>
      expect(wire.close).toHaveBeenCalledWith({
        manager: 'postgres-manager',
        ok: true,
        result: { connection: 'connection-1' },
      }),
    );
    expect(
      JSON.stringify((wire.close as unknown as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain('logical-password');
  });
  it('maps secret-bearing errors to a fixed 500', async () => {
    const wire = { close: vi.fn() } as unknown as Wire;
    render(
      <DeleteConnectionRequest
        {...base({} as RPCCaller, wire)}
        initialError="logical-password appeared"
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to delete the PostgreSQL connection');
  });
});
