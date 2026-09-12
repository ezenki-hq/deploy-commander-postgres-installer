import type { AdminCredentials } from './credentials';
import type { RunnerMetadata } from './postgresContracts';

/** Build the one persistent service used by the PostgreSQL installation. */
export function buildInstallPlan(credentials: AdminCredentials): RunnerMetadata {
  return {
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
            metadata: {
              engine: 'postgres',
              version: '15',
              administrator: credentials,
            },
          },
        ],
        volumes: [
          {
            name: 'postgres-data',
            mount_path: '/var/lib/postgresql/data',
          },
        ],
      },
    },
    volumes: ['postgres-data'],
  };
}
