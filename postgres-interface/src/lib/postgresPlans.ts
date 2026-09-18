import type { AdminCredentials } from './credentials';
import type { LoginCredentials } from './credentials';
import type { LogicalCredentials } from './legacyCredentials';
import type { AccessRequest } from './postgresConnectionRequest';
import { connectionLabels } from './postgresConnectionRequest';
import { buildAccessService, buildCleanupService } from './postgresAccessPlans';
import { buildCatalogDeleteHook, buildCatalogHook } from './postgresCatalog';
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
  if (typeof administrator !== 'object' || administrator === null)
    throw new Error('Invalid administrator credentials');
  if (
    typeof administrator.username !== 'string' ||
    !ADMIN_USERNAME_PATTERN.test(administrator.username)
  ) {
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

export interface CleanupPlanInput {
  administrator: AdminCredentials;
  login: LoginCredentials;
  access: AccessRequest;
  resourceId: string;
  platform: PlatformConnection;
}

/**
 * Build either the runner-native cleanup plan or the legacy service-only plan
 * used by recovery of pre-v2 runs. Keeping the compatibility overload here
 * lets an older in-flight run finish while all new runs use access metadata.
 */
export function buildCleanupPlan(input: CleanupPlanInput): RunnerMetadata;
export function buildCleanupPlan(
  administrator: AdminCredentials,
  database: string,
  username: string,
  platform: PlatformConnection,
): RunnerMetadata;
export function buildCleanupPlan(
  inputOrAdministrator: CleanupPlanInput | AdminCredentials,
  databaseOrDatabaseName?: string,
  username?: string,
  platformOrPlatform?: PlatformConnection,
): RunnerMetadata {
  if (databaseOrDatabaseName === undefined) {
    const input = inputOrAdministrator as CleanupPlanInput;
    const service = buildCleanupService(
      input.access,
      input.administrator,
      input.login,
      input.platform,
    );
    const catalogHook = buildCatalogDeleteHook(input.access, input.resourceId);
    return catalogHook ? { ...service, object_hooks: [catalogHook] } : service;
  }

  const administrator = inputOrAdministrator as AdminCredentials;
  assertGeneratedDatabase(databaseOrDatabaseName);
  assertGeneratedUsername(username);
  if (!platformOrPlatform) throw new Error('Invalid platform connection');
  return buildAdminService(administrator, platformOrPlatform, ['sh', '-ceu', CLEANUP_SCRIPT], {
    TARGET_DATABASE: databaseOrDatabaseName,
    TARGET_USERNAME: username,
  });
}

export function buildConnectionMetadata(
  login: LoginCredentials,
  access: AccessRequest,
  platform: PlatformConnection,
): PostgresConnectionMetadata;
export function buildConnectionMetadata(
  logical: LogicalCredentials,
  platform: PlatformConnection,
): PostgresConnectionMetadata;
export function buildConnectionMetadata(
  loginOrLogical: LoginCredentials | LogicalCredentials,
  accessOrPlatform: AccessRequest | PlatformConnection,
  maybePlatform?: PlatformConnection,
): PostgresConnectionMetadata {
  if (maybePlatform !== undefined) {
    const login = loginOrLogical as LoginCredentials;
    const access = accessOrPlatform as AccessRequest;
    validateLoginForConnection(login);
    validateAccessForConnection(access);
    return {
      host: 'postgres',
      port: 5432,
      database: access.scope === 'database' ? access.database : 'postgres',
      username: login.username,
      password: login.password,
      platform_connection: parsePlatformConnection(maybePlatform),
      access,
    };
  }

  const logical = loginOrLogical as LogicalCredentials;
  validateLogical(logical);
  const platform = accessOrPlatform as PlatformConnection;
  const platformConnection = parsePlatformConnection(platform);
  // Legacy metadata intentionally has no access discriminator. It is only
  // accepted by the v1 recovery path; new plans always use the overload above.
  return {
    host: 'postgres',
    port: 5432,
    database: logical.database,
    username: logical.username,
    password: logical.password,
    platform_connection: platformConnection,
  } as PostgresConnectionMetadata;
}

function validateLoginForConnection(login: LoginCredentials): void {
  if (typeof login !== 'object' || login === null || !USERNAME_PATTERN.test(login.username)) {
    throw new Error('Invalid login username');
  }
  assertNonBlank(login.password, 'login password');
}

function validateAccessForConnection(access: AccessRequest): void {
  if (typeof access !== 'object' || access === null) throw new Error('Invalid access request');
  if (access.scope === 'database') {
    assertNonBlank(access.database, 'database');
    return;
  }
  if (access.scope !== 'full' || typeof access.superuser !== 'boolean') {
    throw new Error('Invalid access request');
  }
}

export interface ConnectionRunPlanInput {
  administrator: AdminCredentials;
  login: LoginCredentials;
  access: AccessRequest;
  callerId: string;
  resourceId: string;
  platform: PlatformConnection;
  callerLabels: Record<string, string>;
}

/** Assemble the complete runner metadata for one approved connection. */
export function buildConnectionRunPlan(input: ConnectionRunPlanInput): RunnerMetadata {
  const service = buildAccessService(
    input.access,
    input.administrator,
    input.login,
    input.platform,
  );
  const metadata = buildConnectionMetadata(input.login, input.access, input.platform);
  const hook = buildCatalogHook(input.access, input.resourceId);
  return {
    ...service,
    connections: {
      create: [
        {
          name: 'postgres-connection',
          manager: input.callerId,
          resource: { id: input.resourceId },
          metadata,
          labels: connectionLabels(input.access, input.callerLabels),
        },
      ],
    },
    ...(hook ? { object_hooks: [hook] } : {}),
  };
}
