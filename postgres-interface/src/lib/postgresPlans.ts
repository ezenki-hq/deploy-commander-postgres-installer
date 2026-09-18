import type { AdminCredentials } from './credentials';
import type { LogicalCredentials } from './legacyCredentials';
import {
  parsePlatformConnection,
  type PlatformConnection,
  type PostgresConnectionMetadata,
  type RunnerMetadata,
} from './postgresContracts';

/** The fixed provisioning program run inside the temporary PostgreSQL client. */
export const PROVISION_SCRIPT = String.raw`attempt=1
while ! pg_isready -q; do
  if [ "$attempt" -ge 60 ]; then
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if ! psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv target_database TARGET_DATABASE
\getenv target_username TARGET_USERNAME
\getenv target_password TARGET_PASSWORD
SELECT format('CREATE ROLE %I', :'target_username')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'target_username', :'target_password')
\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'target_database', :'target_username')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_database')
\gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'target_database', :'target_username')
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', :'target_database')
\gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'target_database', :'target_username')
\gexec
SQL
then
  echo "PostgreSQL provisioning failed" >&2
  exit 1
fi
if ! PGDATABASE="$TARGET_DATABASE" psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv target_username TARGET_USERNAME
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'target_username')
\gexec
SQL
then
  echo "PostgreSQL provisioning failed" >&2
  exit 1
fi`;

/** The fixed cleanup program run inside the temporary PostgreSQL client. */
export const CLEANUP_SCRIPT = String.raw`attempt=1
while ! pg_isready -q; do
  if [ "$attempt" -ge 60 ]; then
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if ! psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv target_database TARGET_DATABASE
\getenv target_username TARGET_USERNAME
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS false', :'target_database')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_database')
\gexec
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'target_database' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'target_database')
\gexec
SELECT format('DROP ROLE IF EXISTS %I', :'target_username')
\gexec
SQL
then
  echo "PostgreSQL cleanup failed" >&2
  exit 1
fi`;

const ADMIN_USERNAME_PATTERN = /^dc_admin_[0-9a-f]{32}$/;
const DATABASE_PATTERN = /^db_[0-9a-f]{32}$/;
const USERNAME_PATTERN = /^dc_user_[0-9a-f]{32}$/;

function assertNonBlank(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${label}`);
  }
}
function assertGeneratedDatabase(value: unknown): asserts value is string {
  assertNonBlank(value, 'logical database');
  if (!DATABASE_PATTERN.test(value)) {
    throw new Error('Invalid logical database');
  }
}

function assertGeneratedUsername(value: unknown): asserts value is string {
  assertNonBlank(value, 'logical username');
  if (!USERNAME_PATTERN.test(value)) {
    throw new Error('Invalid logical username');
  }
}

function validateAdministrator(administrator: AdminCredentials): void {
  if (typeof administrator !== 'object' || administrator === null) throw new Error('Invalid administrator credentials');
  if (typeof administrator.username !== 'string' || !ADMIN_USERNAME_PATTERN.test(administrator.username)) {
    throw new Error('Invalid administrator username');
  }
  assertNonBlank(administrator.password, 'administrator password');
}

function validateLogical(logical: LogicalCredentials): void {
  if (typeof logical !== 'object' || logical === null) {
    throw new Error('Invalid logical credentials');
  }
  assertGeneratedDatabase(logical.database);
  assertGeneratedUsername(logical.username);
  assertNonBlank(logical.password, 'logical password');
}

function adminEnvironment(administrator: AdminCredentials): Record<string, string> {
  return {
    PGHOST: 'postgres',
    PGPORT: '5432',
    PGDATABASE: 'postgres',
    PGUSER: administrator.username,
    PGPASSWORD: administrator.password,
  };
}

function buildAdminService(
  administrator: AdminCredentials,
  platform: PlatformConnection,
  command: string[],
  target: Record<string, string>,
): RunnerMetadata {
  validateAdministrator(administrator);
  const validatedPlatform = parsePlatformConnection(platform);
  return {
    services: {
      'postgres-admin': {
        image: 'postgres:15',
        role: 'runner',
        connections: [validatedPlatform],
        environment: { ...adminEnvironment(administrator), ...target },
        command,
      },
    },
  };
}

export function buildProvisionPlan(
  administrator: AdminCredentials,
  logical: LogicalCredentials,
  platform: PlatformConnection,
): RunnerMetadata {
  validateLogical(logical);
  return buildAdminService(administrator, platform, ['sh', '-ceu', PROVISION_SCRIPT], {
    TARGET_DATABASE: logical.database,
    TARGET_USERNAME: logical.username,
    TARGET_PASSWORD: logical.password,
  });
}

export function buildCleanupPlan(
  administrator: AdminCredentials,
  database: string,
  username: string,
  platform: PlatformConnection,
): RunnerMetadata {
  assertGeneratedDatabase(database);
  assertGeneratedUsername(username);
  return buildAdminService(administrator, platform, ['sh', '-ceu', CLEANUP_SCRIPT], {
    TARGET_DATABASE: database,
    TARGET_USERNAME: username,
  });
}

export function buildConnectionMetadata(
  logical: LogicalCredentials,
  platform: PlatformConnection,
): PostgresConnectionMetadata {
  validateLogical(logical);
  const platformConnection = parsePlatformConnection(platform);
  return {
    host: 'postgres',
    port: 5432,
    database: logical.database,
    username: logical.username,
    password: logical.password,
    platform_connection: platformConnection,
  };
}
