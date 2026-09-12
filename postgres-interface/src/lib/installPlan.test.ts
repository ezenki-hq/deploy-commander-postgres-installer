import { describe, expect, it } from 'vitest';
import type { AdminCredentials } from './credentials';
import { buildInstallPlan } from './installPlan';

describe('buildInstallPlan', () => {
  it('stores administrator credentials in resource metadata for recovery', () => {
    const credentials: AdminCredentials = {
      username: 'dc_admin_0123456789abcdef0123456789abcdef',
      password: 'secret-password',
    };

    const plan = buildInstallPlan(credentials);

    expect(plan).toEqual({
      services: {
        postgres: {
          image: 'postgres:15',
          aliases: ['postgres'],
          environment: {
            POSTGRES_USER: credentials.username,
            POSTGRES_PASSWORD: credentials.password,
            POSTGRES_DB: 'postgres',
          },
          resources: [
            {
              resource_type: 'postgres',
              name: 'postgres',
              metadata: { engine: 'postgres', version: '15', administrator: credentials },
            },
          ],
          volumes: [{ name: 'postgres-data', mount_path: '/var/lib/postgresql/data' }],
        },
      },
      volumes: ['postgres-data'],
    });

    const resourceMetadata = plan.services?.postgres?.resources?.[0]?.metadata;
    expect(resourceMetadata).toEqual({ engine: 'postgres', version: '15', administrator: credentials });
    expect(JSON.stringify(resourceMetadata)).not.toContain('logical-password');
  });

  it('rejects an administrator username in the reserved PostgreSQL namespace', () => {
    expect(() => buildInstallPlan({
      username: 'pg_admin_0123456789abcdef0123456789abcdef',
      password: 'secret-password',
    })).toThrow('Invalid administrator username');
  });
});
