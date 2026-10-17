import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { PostgresConnection } from './connections';
import type { PostgresInstallation } from './resources';
import {
  CONSTRAINED_FULL_SCRIPT,
  DATABASE_CLEANUP_SCRIPT,
  DATABASE_PROVISION_SCRIPT,
  EXISTING_DATABASE_SCRIPT,
  ROLE_CLEANUP_SCRIPT,
  SUPERUSER_SCRIPT,
  buildBatchDeletePlan,
  buildDeletePlan,
  buildInstallPlan,
  buildProvisionPlan,
  buildTeardownPlan,
} from './plans';

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
  metadata: {},
} satisfies PostgresConnection;

it('builds a versioned secret-backed postgres service, volume, and resource', () => {
  const plan = buildInstallPlan();
  expect(plan).toMatchObject({
    values_version: 1,
    services: {
      postgres: {
        image: 'postgres:15',
        aliases: ['postgres'],
        network_groups: ['postgres-internal'],
        health_check: {
          test: [
            'CMD-SHELL',
            'pg_isready -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
          ],
          interval_seconds: 10,
          timeout_seconds: 5,
          start_period_seconds: 30,
          retries: 3,
          wait_timeout_seconds: 300,
        },
        environment: {
          POSTGRES_USER: '[[secret:run:USERNAME]]',
          POSTGRES_PASSWORD: '[[secret:run:PASSWORD]]',
          POSTGRES_DB: 'postgres',
        },
        resources: [
          {
            resource_type: 'postgres',
            name: 'postgres',
            metadata: { engine: 'postgres', version: '15', secret_keys: ['USERNAME', 'PASSWORD'] },
            secrets: ['USERNAME', 'PASSWORD'],
          },
        ],
        volumes: [{ name: 'postgres-data', mount_path: '/var/lib/postgresql/data' }],
      },
    },
    volumes: ['postgres-data'],
  });
  expect(JSON.stringify(plan)).not.toMatch(/dc_admin_|secret-value/);
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
    databaseOwner: `dc_db_${'c'.repeat(32)}`,
    callerLabels: { team: 'payments' },
  });
  expect(plan.services!['postgres-admin']).toMatchObject({
    image: 'postgres:15',
    role: 'runner',
    network_groups: ['postgres-internal'],
    environment: { PGCONNECT_TIMEOUT: '5' },
  });
  expect(plan.services!['postgres-admin']).not.toHaveProperty('connections');
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
  expect(plan).toMatchObject({ values_version: 1 });
  expect(plan.services!['postgres-admin'].environment).toMatchObject({
    PGUSER: '[[secret:resource:resource-1:USERNAME]]',
    PGPASSWORD: '[[secret:resource:resource-1:PASSWORD]]',
    TARGET_USERNAME: '[[secret:run:USERNAME]]',
    TARGET_PASSWORD: '[[secret:run:PASSWORD]]',
  });
  expect(plan.connections!.create![0]).toMatchObject({ secrets: ['USERNAME', 'PASSWORD'] });
  expect(plan.connections!.create![0].metadata).toMatchObject({
    host: 'postgres',
    port: 5432,
    database: 'orders',
    secret_keys: ['USERNAME', 'PASSWORD'],
    access: { scope: 'database', operation: 'create', database: 'orders' },
  });
  expect(JSON.stringify(plan)).not.toContain('connection-secret');
  expect(JSON.stringify(plan)).not.toContain('dc_user_');
  expect(plan.connections!.create![0].metadata).not.toHaveProperty('platform_connection');
  expect(JSON.stringify(plan)).not.toContain('object_hooks');
});

it('emits safe lifecycle logs and exits from every postgres admin script', () => {
  const scripts = [
    DATABASE_PROVISION_SCRIPT,
    EXISTING_DATABASE_SCRIPT,
    CONSTRAINED_FULL_SCRIPT,
    SUPERUSER_SCRIPT,
    ROLE_CLEANUP_SCRIPT,
    DATABASE_CLEANUP_SCRIPT,
  ];

  for (const script of scripts) {
    expect(script).toContain('POSTGRES_MANAGER: postgres-admin started');
    expect(script).toContain('POSTGRES_MANAGER: postgres-admin completed');
    expect(script).toContain('POSTGRES_MANAGER_ERROR: postgres-admin failed');
    expect(script).toContain('POSTGRES_MANAGER_ERROR: postgres-unavailable');
    expect(script).toContain('PGCONNECT_TIMEOUT');
    expect(script.trimEnd()).toMatch(/exit 0$/);
    expect(script).not.toContain('|| exit 1');
    expect(script).not.toContain('<<<');
    expect(() => execFileSync('sh', ['-n', '-c', script])).not.toThrow();
  }
});

it('runs a one-shot postgres admin command to completion with safe logs', () => {
  const root = mkdtempSync(join(tmpdir(), 'postgres-admin-'));
  writeFileSync(join(root, 'pg_isready'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(root, 'psql'), '#!/bin/sh\ncat >/dev/null\nexit 0\n');
  chmodSync(join(root, 'pg_isready'), 0o755);
  chmodSync(join(root, 'psql'), 0o755);

  try {
    const output = execFileSync('sh', ['-ceu', SUPERUSER_SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ''}`,
        PGCONNECT_TIMEOUT: '5',
      },
    });
    expect(output).toContain('POSTGRES_MANAGER: postgres-admin started');
    expect(output).toContain('POSTGRES_MANAGER: configuring superuser role');
    expect(output).toContain('POSTGRES_MANAGER: postgres-admin completed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    TARGET_USERNAME: '[[secret:connection:connection-1:USERNAME]]',
    DATABASE_OWNER: `dc_db_${'c'.repeat(32)}`,
  });
  expect(plan.connections!.remove![0]).toEqual({
    name: 'postgres-connection',
    id: target.item.id,
    resource: { id: target.resourceId },
  });
});

it('builds one runner plan with ordered cleanups and removals for a batch', () => {
  const second = {
    ...target,
    item: { ...target.item, id: 'connection-2' },
  };
  const owner = `dc_db_${'d'.repeat(32)}`;
  const plan = buildBatchDeletePlan({
    installation,
    targets: [
      { target, effect: 'role-only' },
      { target: second, effect: 'role-and-database', databaseOwner: owner },
    ],
  });
  const service = plan.services!['postgres-admin'];
  const command = service.command?.[2] ?? '';
  expect(Object.keys(plan.services ?? {})).toEqual(['postgres-admin']);
  expect(service.environment).toMatchObject({
    TARGET_USERNAME_0: '[[secret:connection:connection-1:USERNAME]]',
    TARGET_USERNAME_1: '[[secret:connection:connection-2:USERNAME]]',
    TARGET_DATABASE_0: 'orders',
    TARGET_DATABASE_1: 'orders',
    DATABASE_OWNER_1: owner,
  });
  expect(command.indexOf('ROLE_CLEANUP')).toBe(-1);
  expect(command.indexOf('listing databases for cleanup')).toBeLessThan(
    command.indexOf('checking database ownership'),
  );
  expect(command).toContain('\\getenv target_username TARGET_USERNAME');
  expect(command).toContain('DROP DATABASE');
  expect(command).not.toContain('dc_user_');
  expect(() => execFileSync('sh', ['-n', '-c', command])).not.toThrow();
  expect(plan.connections?.remove).toEqual([
    {
      name: 'postgres-connection-0',
      id: target.item.id,
      resource: { id: target.resourceId },
    },
    {
      name: 'postgres-connection-1',
      id: second.item.id,
      resource: { id: second.resourceId },
    },
  ]);
});
