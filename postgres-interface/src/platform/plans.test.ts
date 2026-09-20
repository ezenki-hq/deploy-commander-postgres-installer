import { expect, it } from 'vitest';
import type { PostgresConnection } from './connections';
import type { PostgresInstallation } from './resources';
import { buildDeletePlan, buildInstallPlan, buildProvisionPlan, buildTeardownPlan } from './plans';

const administrator = {
  username: `dc_admin_${'a'.repeat(32)}`,
  password: 'secret-value-that-is-long-enough',
};

const installation: PostgresInstallation = {
  resource: {
    id: 'resource-1',
    manager: 'postgres-manager',
    agent: 'agent-1',
    type: 'postgres',
    name: 'postgres',
    external: false,
    created_at: '2026-09-20T00:00:00Z',
    updated_at: '2026-09-20T00:00:00Z',
  },
  administrator,
  platformConnection: { type: 'Platform', data: { network: 'postgres-network' } },
};

const target = {
  item: {
    id: 'connection-1',
    manager: 'consumer-1',
    resource: 'resource-1',
    external: false,
    created_at: '2026-09-20T00:00:00Z',
    updated_at: '2026-09-20T00:00:00Z',
    labels: {
      'postgres.access': 'database',
      'postgres.database': 'orders',
      'postgres.database-origin': 'managed',
    },
  },
  managerId: 'consumer-1',
  resourceId: 'resource-1',
  authority: { access: 'database', database: 'orders', origin: 'managed' as const },
  access: { scope: 'database' as const, operation: 'create' as const, database: 'orders' },
  username: `dc_user_${'b'.repeat(32)}`,
  password: 'connection-secret',
  platformConnection: installation.platformConnection,
  metadata: {},
} satisfies PostgresConnection;

it('builds one stable postgres service, volume, and resource', () => {
  expect(buildInstallPlan(administrator)).toEqual({
    services: {
      postgres: {
        image: 'postgres:15',
        aliases: ['postgres'],
        environment: {
          POSTGRES_USER: administrator.username,
          POSTGRES_PASSWORD: administrator.password,
          POSTGRES_DB: 'postgres',
        },
        resources: [
          {
            resource_type: 'postgres',
            name: 'postgres',
            metadata: { engine: 'postgres', version: '15', administrator },
          },
        ],
        volumes: [{ name: 'postgres-data', mount_path: '/var/lib/postgresql/data' }],
      },
    },
    volumes: ['postgres-data'],
  });
});

it('uses the runner teardown action without guessed removals', () => {
  expect(buildTeardownPlan()).toEqual({});
});

it('runs psql before creating the labeled connection record', () => {
  const plan = buildProvisionPlan({
    installation,
    callerId: 'consumer-1',
    access: { scope: 'database', operation: 'create', database: 'orders' },
    origin: 'managed',
    login: { username: `dc_user_${'b'.repeat(32)}`, password: 'connection-secret' },
    databaseOwner: `dc_db_${'c'.repeat(32)}`,
    callerLabels: { team: 'payments' },
  });
  expect(plan.services!['postgres-admin']).toMatchObject({
    image: 'postgres:15',
    role: 'runner',
    connections: [installation.platformConnection],
  });
  expect(plan.connections?.create).toEqual([
    expect.objectContaining({
      name: 'postgres-connection',
      manager: 'consumer-1',
      resource: { id: 'resource-1' },
      labels: {
        team: 'payments',
        'postgres.access': 'database',
        'postgres.database': 'orders',
        'postgres.database-origin': 'managed',
      },
    }),
  ]);
  expect(plan.connections!.create![0].metadata).toMatchObject({
    host: 'postgres',
    port: 5432,
    database: 'orders',
    username: `dc_user_${'b'.repeat(32)}`,
    password: 'connection-secret',
    access: { scope: 'database', operation: 'create', database: 'orders' },
    platform_connection: installation.platformConnection,
  });
  expect(JSON.stringify(plan)).not.toContain('object_hooks');
});

it.each([
  [{ scope: 'database', operation: 'existing', database: 'warehouse' }, 'existing'],
  [{ scope: 'full', superuser: false }, 'constrained'],
  [{ scope: 'full', superuser: true }, 'superuser'],
] as const)('builds the access plan for %s', (access, name) => {
  const plan = buildProvisionPlan({
    installation,
    callerId: 'consumer-1',
    access,
    origin: access.scope === 'database' ? 'existing' : undefined,
    login: { username: `dc_user_${'b'.repeat(32)}`, password: 'connection-secret' },
    databaseOwner: access.scope === 'database' ? `dc_db_${'c'.repeat(32)}` : undefined,
    callerLabels: {},
  });
  expect(name).toBeTypeOf('string');
  expect(plan.services!['postgres-admin'].command).toEqual(['sh', '-ceu', expect.any(String)]);
});

it('removes only the role when another managed connection remains', () => {
  const plan = buildDeletePlan({ installation, target, effect: 'role-only' });
  expect(plan.connections?.remove).toEqual([
    {
      name: 'postgres-connection',
      id: target.item.id,
      resource: { id: target.resourceId },
    },
  ]);
  expect(plan.services!['postgres-admin'].environment).not.toHaveProperty('DATABASE_OWNER');
});

it('drops a final managed database through its deterministic owner role', () => {
  const plan = buildDeletePlan({
    installation,
    target,
    effect: 'role-and-database',
    databaseOwner: `dc_db_${'c'.repeat(32)}`,
  });
  expect(plan.services!['postgres-admin'].environment).toMatchObject({
    TARGET_DATABASE: 'orders',
    DATABASE_OWNER: `dc_db_${'c'.repeat(32)}`,
  });
  expect(plan.connections!.remove![0]).toEqual({
    name: 'postgres-connection',
    id: target.item.id,
    resource: { id: target.resourceId },
  });
});
