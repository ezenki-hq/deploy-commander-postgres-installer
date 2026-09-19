import { describe, expect, it } from 'vitest';
import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import { CATALOG_DELETE_QUERY, CATALOG_UPSERT_QUERY, catalogRecordId } from './postgresCatalog';
import {
  makeCleanupNote,
  makeProvisionNote,
  parseCleanupRun,
  parseConnectionNote,
  parseProvisionRun,
} from './connectionRuns';

const identity = {
  operationId: '01234567-89ab-4def-8123-456789abcdef',
  callerId: 'consumer:manager % one',
  resourceId: 'resource:one/ä',
};
const platform = { type: 'Platform' as const, data: { network: 'postgres-network' } };
const username = 'dc_user_0123456789abcdef0123456789abcdef';
const password = 'logical-password';
type MutableMetadata = {
  services: { 'postgres-admin': { command: string[]; environment: Record<string, unknown> } };
  connections?: {
    create: Array<{
      name?: string;
      labels: Record<string, string>;
      metadata?: Record<string, unknown>;
    }>;
  };
  object_hooks?: unknown;
};
const mutableMetadata = (result: RPC.GetRun): MutableMetadata =>
  result.config.metadata as unknown as MutableMetadata;

function runResult(
  action: 'create-connection' | 'cleanup-connection',
  access:
    | { scope: 'database'; operation: 'create' | 'existing'; database: string }
    | { scope: 'full'; superuser: boolean },
  status = 2,
  id = `${action}-run`,
  labels: Record<string, string> = { team: 'payments' },
): RPC.GetRun {
  const database = access.scope === 'database' ? access.database : 'postgres';
  const mode =
    access.scope === 'database'
      ? `${access.operation}-database`
      : `full-${access.superuser ? 'superuser' : 'constrained'}`;
  const cleanup = action === 'cleanup-connection';
  const script =
    cleanup && access.scope === 'database' && access.operation === 'create'
      ? 'ALTER DATABASE %I; pg_terminate_backend; DROP DATABASE %I; REASSIGN OWNED BY; DROP OWNED BY; DROP ROLE'
      : cleanup
        ? "database_list=$(mktemp); has_database_privilege(current_user, datname, 'CONNECT'); REASSIGN OWNED BY; DROP OWNED BY; DROP ROLE"
        : 'REVOKE ALL PRIVILEGES';
  const allLabels =
    access.scope === 'database'
      ? { ...labels, 'postgres.access': 'database', 'postgres.database': database }
      : { ...labels, 'postgres.access': 'full' };
  const metadata: Record<string, unknown> = {
    services: {
      'postgres-admin': {
        image: 'postgres:15',
        role: 'runner',
        environment: {
          PGHOST: 'postgres',
          PGPORT: '5432',
          PGDATABASE: 'postgres',
          PGUSER: 'dc_admin_0123456789abcdef0123456789abcdef',
          PGPASSWORD: 'admin-secret',
          ACCESS_MODE: mode,
          TARGET_DATABASE: database,
          TARGET_USERNAME: username,
          TARGET_PASSWORD: password,
        },
        connections: [platform],
        command: ['sh', '-ceu', script],
      },
    },
  };
  if (!cleanup) {
    metadata.connections = {
      create: [
        {
          name: 'postgres-connection',
          manager: identity.callerId,
          resource: { id: identity.resourceId },
          metadata: {
            host: 'postgres',
            port: 5432,
            database,
            username,
            password,
            platform_connection: platform,
            access,
          },
          labels: allLabels,
        },
      ],
    };
    if (access.scope === 'database')
      metadata.object_hooks = [
        {
          kind: 'connection',
          name: 'postgres-connection',
          create: {
            before: {
              query: CATALOG_UPSERT_QUERY,
              bindings: {
                record_id: catalogRecordId(identity.resourceId, database),
                resource_id: identity.resourceId,
                name: database,
                origin: access.operation === 'create' ? 'managed' : 'pre-existing',
              },
            },
          },
        },
      ];
  } else if (access.scope === 'database' && access.operation === 'create') {
    metadata.object_hooks = [
      {
        kind: 'container',
        name: 'postgres-admin',
        remove: {
          after: {
            query: CATALOG_DELETE_QUERY,
            bindings: { record_id: catalogRecordId(identity.resourceId, database) },
          },
        },
      },
    ];
  }
  return {
    run: {
      id,
      action,
      note:
        action === 'create-connection' ? makeProvisionNote(identity) : makeCleanupNote(identity),
      status,
      queued_at: '2026-09-11T00:00:00.000Z',
      created_at: '2026-09-11T00:00:00.000Z',
      updated_at: '2026-09-11T00:00:00.000Z',
    },
    config: {
      id,
      action,
      manager: 'manager-1',
      run: id,
      runner: 'ezenki/deploy-commander-runner:latest',
      metadata,
    },
  } as RPC.GetRun;
}

describe('connection run notes', () => {
  it('writes and parses v2 notes without secrets', () => {
    const note = makeProvisionNote(identity);
    expect(parseConnectionNote(note)).toEqual({ kind: 'provision', ...identity });
    expect(note).toMatch(/^postgres-provision:v2:/);
    expect(note).not.toContain(password);
  });
  it('accepts legacy v1 notes for recovery', () => {
    expect(
      parseConnectionNote(`postgres-provision:v1:caller:resource:${identity.operationId}`),
    ).toEqual({
      kind: 'provision',
      operationId: identity.operationId,
      callerId: 'caller',
      resourceId: 'resource',
    });
  });
  it.each([
    'postgres-provision:v3:caller:resource:01234567-89ab-4def-8123-456789abcdef',
    'postgres-provision:v1:%E0%A4%A:resource:01234567-89ab-4def-8123-456789abcdef',
    'postgres-provision:v1::resource:01234567-89ab-4def-8123-456789abcdef',
    'postgres-provision:v1:caller:resource:not-an-operation',
    'postgres-unknown:v1:caller:resource:01234567-89ab-4def-8123-456789abcdef',
  ])('rejects malformed note %s', (note) => expect(() => parseConnectionNote(note)).toThrow());
});

describe('connection run records', () => {
  it('recovers a v2 existing-database provision', () => {
    expect(
      parseProvisionRun(
        runResult('create-connection', {
          scope: 'database',
          operation: 'existing',
          database: 'orders',
        }),
      ),
    ).toEqual({
      identity,
      runId: 'create-connection-run',
      status: 2,
      access: { scope: 'database', operation: 'existing', database: 'orders' },
      login: { username, password },
      labels: { team: 'payments', 'postgres.access': 'database', 'postgres.database': 'orders' },
    });
  });
  it.each([
    { scope: 'database', operation: 'create', database: 'orders' },
    { scope: 'database', operation: 'existing', database: 'orders' },
    { scope: 'full', superuser: false },
    { scope: 'full', superuser: true },
  ] as const)('recovers cleanup access mode %j', (access) => {
    expect(parseCleanupRun(runResult('cleanup-connection', access))).toMatchObject({
      identity,
      access,
      login: { username, password },
      platform,
    });
  });
  it('rejects identity and structural mismatches', () => {
    const result = runResult('create-connection', {
      scope: 'database',
      operation: 'existing',
      database: 'orders',
    });
    result.run.note = makeProvisionNote({ ...identity, callerId: 'other-manager' });
    expect(() => parseProvisionRun(result)).toThrow();
    const valid = runResult('create-connection', {
      scope: 'database',
      operation: 'existing',
      database: 'orders',
    });
    mutableMetadata(valid).connections!.create[0].name = 'wrong-hook';
    expect(() => parseProvisionRun(valid)).toThrow();
  });
  it('rejects malformed labels and full access database labels', () => {
    const wrong = runResult('create-connection', { scope: 'full', superuser: false });
    const entry = mutableMetadata(wrong).connections!.create[0];
    entry.labels['postgres.database'] = 'orders';
    expect(() => parseProvisionRun(wrong)).toThrow();
  });
  it('preserves the v1 generated-database recovery boundary', () => {
    const result = runResult('create-connection', {
      scope: 'database',
      operation: 'create',
      database: 'db_0123456789abcdef0123456789abcdef',
    });
    delete mutableMetadata(result).connections;
    delete mutableMetadata(result).services['postgres-admin'].environment.ACCESS_MODE;
    delete mutableMetadata(result).services['postgres-admin'].environment.TARGET_PASSWORD;
    result.run.note = `postgres-provision:v1:${encodeURIComponent(identity.callerId)}:${encodeURIComponent(identity.resourceId)}:${identity.operationId}`;
    expect(() => parseProvisionRun(result)).toThrow();
    mutableMetadata(result).services['postgres-admin'].environment.TARGET_PASSWORD = password;
    expect(parseProvisionRun(result)).toMatchObject({
      access: { scope: 'database', operation: 'create' },
      login: { username },
    });
  });
  it('keeps legacy cleanup recovery credential-free', () => {
    const result = runResult('cleanup-connection', {
      scope: 'database',
      operation: 'create',
      database: 'db_0123456789abcdef0123456789abcdef',
    });
    delete mutableMetadata(result).connections;
    delete mutableMetadata(result).services['postgres-admin'].environment.ACCESS_MODE;
    delete mutableMetadata(result).services['postgres-admin'].environment.TARGET_PASSWORD;
    result.run.note = `postgres-cleanup:v1:${encodeURIComponent(identity.callerId)}:${encodeURIComponent(identity.resourceId)}:${identity.operationId}`;
    expect(parseCleanupRun(result)).toMatchObject({
      access: { scope: 'database', operation: 'create' },
      login: { username, password: '' },
    });
    expect(parseCleanupRun(result)).not.toHaveProperty('platform');
  });
  it('accepts service-only cleanup for created database cleanup', () => {
    const result = runResult('cleanup-connection', {
      scope: 'database',
      operation: 'create',
      database: 'orders',
    });
    delete mutableMetadata(result).object_hooks;
    expect(() => parseCleanupRun(result)).not.toThrow();
  });
  it('rejects a database drop in role-only cleanup', () => {
    const result = runResult('cleanup-connection', {
      scope: 'database',
      operation: 'existing',
      database: 'orders',
    });
    mutableMetadata(result).services['postgres-admin'].command[2] = 'DROP DATABASE orders';
    expect(() => parseCleanupRun(result)).toThrow();
  });
  it('rejects lowercase database drops in role-only cleanup', () => {
    const result = runResult('cleanup-connection', {
      scope: 'database',
      operation: 'existing',
      database: 'orders',
    });
    mutableMetadata(result).services['postgres-admin'].command[2] =
      "database_list=$(mktemp); has_database_privilege(current_user, datname, 'CONNECT'); drop database orders; REASSIGN OWNED BY; DROP OWNED BY; DROP ROLE";
    expect(() => parseCleanupRun(result)).toThrow();
  });
  it('rejects lowercase mutations in created-database cleanup', () => {
    const result = runResult('cleanup-connection', {
      scope: 'database',
      operation: 'create',
      database: 'orders',
    });
    mutableMetadata(result).services['postgres-admin'].command[2] =
      'ALTER DATABASE orders; pg_terminate_backend; drop database orders; REASSIGN OWNED BY; DROP OWNED BY; DROP ROLE';
    expect(() => parseCleanupRun(result)).toThrow();
  });
  it('rejects arbitrary scripts for each cleanup mode', () => {
    const result = runResult('cleanup-connection', { scope: 'full', superuser: false });
    mutableMetadata(result).services['postgres-admin'].command[2] = 'echo cleanup';
    expect(() => parseCleanupRun(result)).toThrow();
  });
});
