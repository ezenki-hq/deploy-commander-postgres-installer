import { describe, expect, it, vi } from 'vitest';
import type { RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import type { PlatformConnection } from './postgresContracts';
import { findExistingConnection, normalizePostgresConnection } from './postgresConnectionContract';
import { PostgresRecoveryRequiredError } from './postgresErrors';

const platform: PlatformConnection = {
  type: 'Platform',
  data: { network: 'current-postgres-network' },
};
const summary: RPC.ConnectionItem = {
  id: 'connection-1',
  manager: 'manager-2',
  resource: 'resource-1',
  external: false,
  created_at: 'now',
  updated_at: 'now',
};
const logicalMetadata = {
  host: 'postgres',
  port: 5432,
  database: 'db_0123456789abcdef0123456789abcdef',
  username: 'dc_user_0123456789abcdef0123456789abcdef',
  password: 'logical-password',
};

function full(metadata: Record<string, unknown>, id = summary.id) {
  return {
    connection: { ...summary, id },
    config: {
      id,
      manager: summary.manager,
      resource: summary.resource,
      metadata,
    },
  };
}

const expected = { managerId: 'manager-2', resourceId: 'resource-1' };

describe('normalizePostgresConnection', () => {
  it('enriches otherwise-valid legacy metadata without mutating the RPC result', () => {
    const received = full(logicalMetadata);
    const before = structuredClone(received);

    const normalized = normalizePostgresConnection(received, expected, platform);

    expect(normalized.config.metadata).toEqual({
      ...logicalMetadata,
      platform_connection: platform,
    });
    expect(received).toEqual(before);
    expect(normalized).not.toBe(received);
    expect(normalized.config).not.toBe(received.config);
    expect(normalized.config.metadata).not.toBe(received.config.metadata);
  });

  it('replaces a valid stale platform connection with the authoritative value', () => {
    const normalized = normalizePostgresConnection(
      full({
        ...logicalMetadata,
        platform_connection: {
          type: 'Platform',
          data: { network: 'stale-network' },
        },
      }),
      expected,
      platform,
    );

    expect(normalized.config.metadata).toMatchObject({
      platform_connection: platform,
    });
  });

  it.each([
    ['host', { ...logicalMetadata, host: 'database' }],
    ['port', { ...logicalMetadata, port: 5433 }],
    ['database', { ...logicalMetadata, database: 'template0' }],
    ['username', { ...logicalMetadata, username: 'postgres' }],
    [
      'reserved username',
      { ...logicalMetadata, username: 'pg_user_0123456789abcdef0123456789abcdef' },
    ],
    ['password', { ...logicalMetadata, password: '' }],
    [
      'platform',
      {
        ...logicalMetadata,
        platform_connection: { type: 'Platform', data: { network: '' } },
      },
    ],
  ])('rejects malformed %s metadata', (_field, metadata) => {
    expect(() => normalizePostgresConnection(full(metadata), expected, platform)).toThrow(
      PostgresRecoveryRequiredError,
    );
  });

  it('rejects a full connection whose id differs from its configuration id', () => {
    const received = full(logicalMetadata);
    received.config.id = 'connection-other';
    expect(() => normalizePostgresConnection(received, expected, platform)).toThrow(
      PostgresRecoveryRequiredError,
    );
  });

  it('rejects a looked-up result whose id differs from the summary id', () => {
    expect(() =>
      normalizePostgresConnection(
        full(logicalMetadata, 'connection-other'),
        { ...expected, connectionId: summary.id },
        platform,
      ),
    ).toThrow(PostgresRecoveryRequiredError);
  });

  it.each([
    [
      'configuration manager',
      {
        ...full(logicalMetadata),
        config: { ...full(logicalMetadata).config, manager: 'manager-other' },
      },
    ],
    [
      'configuration resource',
      {
        ...full(logicalMetadata),
        config: { ...full(logicalMetadata).config, resource: 'resource-other' },
      },
    ],
    [
      'external connection',
      {
        ...full(logicalMetadata),
        connection: { ...full(logicalMetadata).connection, external: true },
      },
    ],
  ])('rejects a mismatched %s', (_field, value) => {
    expect(() => normalizePostgresConnection(value, expected, platform)).toThrow(
      PostgresRecoveryRequiredError,
    );
  });

  it.each([null, undefined])(
    'rejects a present invalid platform value %# instead of treating it as legacy',
    (platformConnection) => {
      expect(() =>
        normalizePostgresConnection(
          full({
            ...logicalMetadata,
            platform_connection: platformConnection,
          }),
          expected,
          platform,
        ),
      ).toThrow(PostgresRecoveryRequiredError);
    },
  );
});

describe('findExistingConnection', () => {
  it('returns one authorized connection enriched with the current platform', async () => {
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [summary],
        limit: 50,
        offset: 0,
        total: 1,
      }),
      getConnection: vi.fn().mockResolvedValue(full(logicalMetadata)),
    } as unknown as RPCCaller;

    await expect(
      findExistingConnection(caller, 'manager-2', 'resource-1', platform),
    ).resolves.toMatchObject({
      config: { metadata: { platform_connection: platform } },
    });
  });

  it('rejects multiple matching connections across pages', async () => {
    const second = { ...summary, id: 'connection-2' };
    const caller = {
      getConnections: vi
        .fn()
        .mockResolvedValueOnce({ items: [summary], limit: 1, offset: 0, total: 2 })
        .mockResolvedValueOnce({ items: [second], limit: 1, offset: 1, total: 2 }),
      getConnection: vi.fn().mockImplementation(async (id: string) => full(logicalMetadata, id)),
    } as unknown as RPCCaller;

    await expect(
      findExistingConnection(caller, 'manager-2', 'resource-1', platform),
    ).rejects.toThrow(PostgresRecoveryRequiredError);
  });

  it.each([
    { items: [], limit: 50, offset: 0, total: 1 },
    { items: [summary], limit: 0, offset: 0, total: 1 },
    { items: [summary], limit: 50, offset: 1, total: 1 },
  ])('rejects inconsistent page data %#', async (page) => {
    const caller = {
      getConnections: vi.fn().mockResolvedValue(page),
    } as unknown as RPCCaller;
    await expect(
      findExistingConnection(caller, 'manager-2', 'resource-1', platform),
    ).rejects.toThrow(PostgresRecoveryRequiredError);
  });

  it('rejects a connection owned by another manager', async () => {
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [{ ...summary, manager: 'manager-other' }],
        limit: 50,
        offset: 0,
        total: 1,
      }),
    } as unknown as RPCCaller;
    await expect(
      findExistingConnection(caller, 'manager-2', 'resource-1', platform),
    ).rejects.toThrow(PostgresRecoveryRequiredError);
  });

  it('normalizes a connection lookup transport failure', async () => {
    const caller = {
      getConnections: vi.fn().mockRejectedValue(new Error('secret transport detail')),
    } as unknown as RPCCaller;
    await expect(
      findExistingConnection(caller, 'manager-2', 'resource-1', platform),
    ).rejects.toThrow('PostgreSQL connection lookup failed');
  });
});

const requestedAccess = {
  scope: 'database' as const,
  operation: 'existing' as const,
  database: 'orders',
};
const requestedLabels = {
  team: 'payments',
  'postgres.access': 'database',
  'postgres.database': 'orders',
};

function requestedMetadata(
  access: typeof requestedAccess | { scope: 'full'; superuser: boolean },
  database = access.scope === 'database' ? access.database : 'postgres',
) {
  return {
    host: 'postgres',
    port: 5432,
    database,
    username: 'dc_user_abcdefabcdefabcdefabcdefabcdefab',
    password: 'logical-password',
    access,
    platform_connection: platform,
  };
}

function candidate(id: string, metadata: Record<string, unknown>, labels: Record<string, string>) {
  return {
    connection: { ...summary, id, labels },
    config: {
      id,
      manager: summary.manager,
      resource: summary.resource,
      metadata,
    },
  };
}

describe('exact multi-connection lookup', () => {
  it('selects an exact identity among unrelated connections and requests labels', async () => {
    const otherSummary = {
      ...summary,
      id: 'connection-full',
      labels: { 'postgres.access': 'full' },
    };
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [{ ...summary, labels: requestedLabels }, otherSummary],
        limit: 50,
        offset: 0,
        total: 2,
      }),
      getConnection: vi
        .fn()
        .mockImplementation(async (id: string) =>
          id === summary.id
            ? candidate(summary.id, requestedMetadata(requestedAccess), requestedLabels)
            : candidate(
                otherSummary.id,
                requestedMetadata({ scope: 'full', superuser: false }),
                otherSummary.labels,
              ),
        ),
    } as unknown as RPCCaller;

    const result = await findExistingConnection(
      caller,
      {
        managerId: 'manager-2',
        resourceId: 'resource-1',
        access: requestedAccess,
        labels: requestedLabels,
      },
      platform,
    );

    expect(result.kind).toBe('match');
    expect(caller.getConnections).toHaveBeenCalledWith({
      manager: 'manager-2',
      resource: 'resource-1',
      labels: {
        'postgres.access': 'database',
        'postgres.database': 'orders',
      },
      label_match: 'all',
      include_labels: true,
      limit: 50,
      offset: 0,
    });
    expect(caller.getConnection).toHaveBeenCalledWith(summary.id, { include_labels: true });
  });

  it('returns none when only unrelated access identities exist', async () => {
    const fullSummary = {
      ...summary,
      id: 'connection-full',
      labels: { 'postgres.access': 'full' },
    };
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [fullSummary],
        limit: 50,
        offset: 0,
        total: 1,
      }),
      getConnection: vi
        .fn()
        .mockResolvedValue(
          candidate(
            fullSummary.id,
            requestedMetadata({ scope: 'full', superuser: false }),
            fullSummary.labels,
          ),
        ),
    } as unknown as RPCCaller;

    await expect(
      findExistingConnection(
        caller,
        {
          managerId: 'manager-2',
          resourceId: 'resource-1',
          access: requestedAccess,
          labels: requestedLabels,
        },
        platform,
      ),
    ).resolves.toEqual({ kind: 'none' });
  });

  it('requires recovery when two exact identities are present', async () => {
    const second = { ...summary, id: 'connection-2', labels: requestedLabels };
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [{ ...summary, labels: requestedLabels }, second],
        limit: 50,
        offset: 0,
        total: 2,
      }),
      getConnection: vi
        .fn()
        .mockImplementation(async (id: string) =>
          candidate(id, requestedMetadata(requestedAccess), requestedLabels),
        ),
    } as unknown as RPCCaller;

    await expect(
      findExistingConnection(
        caller,
        {
          managerId: 'manager-2',
          resourceId: 'resource-1',
          access: requestedAccess,
          labels: requestedLabels,
        },
        platform,
      ),
    ).rejects.toThrow(PostgresRecoveryRequiredError);
  });

  it('returns a conflict when the exact identity has different caller labels', async () => {
    const conflictingLabels = {
      team: 'other',
      'postgres.access': 'database',
      'postgres.database': 'orders',
    };
    const conflictingSummary = { ...summary, labels: conflictingLabels };
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [conflictingSummary],
        limit: 50,
        offset: 0,
        total: 1,
      }),
      getConnection: vi
        .fn()
        .mockResolvedValue(
          candidate(summary.id, requestedMetadata(requestedAccess), conflictingLabels),
        ),
    } as unknown as RPCCaller;

    await expect(
      findExistingConnection(
        caller,
        {
          managerId: 'manager-2',
          resourceId: 'resource-1',
          access: requestedAccess,
          labels: requestedLabels,
        },
        platform,
      ),
    ).resolves.toEqual({ kind: 'conflict', connectionId: summary.id });
  });

  it('distinguishes constrained full access from full superuser access', async () => {
    const superuserSummary = {
      ...summary,
      id: 'connection-superuser',
      labels: { 'postgres.access': 'full' },
    };
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [superuserSummary],
        limit: 50,
        offset: 0,
        total: 1,
      }),
      getConnection: vi
        .fn()
        .mockResolvedValue(
          candidate(
            superuserSummary.id,
            requestedMetadata({ scope: 'full', superuser: true }),
            superuserSummary.labels,
          ),
        ),
    } as unknown as RPCCaller;

    await expect(
      findExistingConnection(
        caller,
        {
          managerId: 'manager-2',
          resourceId: 'resource-1',
          access: { scope: 'full', superuser: false },
          labels: { 'postgres.access': 'full' },
        },
        platform,
      ),
    ).resolves.toEqual({ kind: 'none' });
  });

  it('accepts arbitrary valid database names and enriches the authoritative platform', async () => {
    const access = {
      scope: 'database' as const,
      operation: 'existing' as const,
      database: 'tenant-prod_01',
    };
    const labels = {
      'postgres.access': 'database',
      'postgres.database': 'tenant-prod_01',
    };
    const caller = {
      getConnections: vi.fn().mockResolvedValue({
        items: [{ ...summary, labels }],
        limit: 50,
        offset: 0,
        total: 1,
      }),
      getConnection: vi
        .fn()
        .mockResolvedValue(candidate(summary.id, requestedMetadata(access), labels)),
    } as unknown as RPCCaller;
    const currentPlatform = { type: 'Platform' as const, data: { network: 'current-network' } };

    const result = await findExistingConnection(
      caller,
      {
        managerId: 'manager-2',
        resourceId: 'resource-1',
        access,
        labels,
      },
      currentPlatform,
    );

    expect(result.kind).toBe('match');
    if (result.kind === 'match') {
      expect(result.connection.config.metadata.platform_connection).toEqual(currentPlatform);
      expect(result.connection.config.metadata.database).toBe('tenant-prod_01');
    }
  });
});
