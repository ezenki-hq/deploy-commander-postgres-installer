import { describe, expect, it } from 'vitest';
import { parsePlatformConnection, type PlatformConnection } from './postgresContracts';

describe('runner transport contracts', () => {
  it('supports named connection creation and lifecycle database hooks', () => {
    const metadata = {
      host: 'postgres' as const,
      port: 5432 as const,
      database: 'orders',
      username: 'dc_user_0123456789abcdef0123456789abcdef',
      password: 'secret',
      platform_connection: {
        type: 'Platform' as const,
        data: { network: 'postgres-network' },
      },
      access: { scope: 'database' as const, operation: 'existing' as const, database: 'orders' },
    };
    expect({
      connections: {
        create: [
          {
            name: 'postgres-connection',
            manager: 'manager-1',
            resource: { id: 'resource-1' },
            metadata,
            labels: { 'postgres.access': 'database', 'postgres.database': 'orders' },
          },
        ],
      },
      object_hooks: [
        {
          kind: 'connection' as const,
          name: 'postgres-connection',
          create: { before: { query: 'SELECT 1', bindings: { resource_id: 'resource-1' } } },
        },
      ],
    }).toMatchObject({ connections: { create: [{ name: 'postgres-connection' }] } });
  });
});

describe('parsePlatformConnection', () => {
  it('accepts an exact platform connection with a non-blank network', () => {
    const connection: PlatformConnection = parsePlatformConnection({
      type: 'Platform',
      data: { network: 'postgres-network' },
    });

    expect(connection).toEqual({
      type: 'Platform',
      data: { network: 'postgres-network' },
    });
  });

  it.each([
    { type: 'Platform', data: { network: '' } },
    { type: 'Platform', data: { network: '   ' } },
    { type: 'platform', data: { network: 'postgres-network' } },
    { type: 'Network', data: { network: 'postgres-network' } },
    { type: 'Platform', data: {} },
    { type: 'Platform' },
    { type: 'Platform', data: { network: 123 } },
    { type: 'Platform', data: { network: 'postgres-network', extra: true } },
    { type: 'Platform', data: { network: 'postgres-network' }, extra: true },
    null,
    [],
  ])('rejects malformed value %j', (value) => {
    expect(() => parsePlatformConnection(value)).toThrow();
  });

  it('trims surrounding network whitespace before returning the contract', () => {
    expect(
      parsePlatformConnection({
        type: 'Platform',
        data: { network: '  postgres-network  ' },
      }),
    ).toEqual({
      type: 'Platform',
      data: { network: 'postgres-network' },
    });
  });
});
