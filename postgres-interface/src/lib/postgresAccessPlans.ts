import type { AccessRequest, DatabaseAccess, FullAccess } from './postgresConnectionRequest';
import type { AdminCredentials, LoginCredentials } from './credentials';
import {
  parsePlatformConnection,
  type PlatformConnection,
  type RunnerMetadata,
} from './postgresContracts';

const USERNAME_PATTERN = /^dc_user_[0-9a-f]{32}$/;

const readiness = String.raw`attempt=1
while ! pg_isready -q; do
  if [ "$attempt" -ge 60 ]; then
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 2
done`;

const psqlFailure = (message: string): string => `then
  echo "${message}" >&2
  exit 1
fi`;

const existingGrantSql = String.raw`\getenv target_database TARGET_DATABASE
\getenv target_username TARGET_USERNAME
SELECT format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO %I', :'target_database', :'target_username')
\gexec`;

const broadDatabaseGrantSql = String.raw`\getenv target_username TARGET_USERNAME
SELECT format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', n.nspname, :'target_username')
FROM pg_namespace AS n
WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
\gexec
SELECT format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I TO %I', n.nspname, :'target_username')
FROM pg_namespace AS n
WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
\gexec
SELECT format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I TO %I', n.nspname, :'target_username')
FROM pg_namespace AS n
WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
\gexec
SELECT format('GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I TO %I', n.nspname, :'target_username')
FROM pg_namespace AS n
WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO %I',
  owner_role.rolname, n.nspname, :'target_username'
)
FROM pg_roles AS owner_role
CROSS JOIN pg_namespace AS n
WHERE n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
  AND pg_has_role(owner_role.rolname, 'member')
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
  owner_role.rolname, n.nspname, :'target_username'
)
FROM pg_roles AS owner_role
CROSS JOIN pg_namespace AS n
WHERE n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
  AND pg_has_role(owner_role.rolname, 'member')
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO %I',
  owner_role.rolname, n.nspname, :'target_username'
)
FROM pg_roles AS owner_role
CROSS JOIN pg_namespace AS n
WHERE n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
  AND pg_has_role(owner_role.rolname, 'member')
\gexec`;

const createDatabaseScript = String.raw`${readiness}
if ! database_exists=$(psql -X --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 2>/dev/null <<'SQL'
\getenv target_database TARGET_DATABASE
SELECT 1 FROM pg_database WHERE datname = :'target_database';
SQL
); then
  echo "PostgreSQL database collision check failed" >&2
  exit 1
fi
if [ "$database_exists" = "1" ]; then
  echo "POSTGRES_MANAGER_ERROR: database-collision" >&2
  exit 45
fi
if ! psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv target_database TARGET_DATABASE
\getenv target_username TARGET_USERNAME
\getenv target_password TARGET_PASSWORD
SELECT format('CREATE ROLE %I', :'target_username')
\gexec
SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'target_username', :'target_password'
)
\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'target_database', :'target_username')
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', :'target_database')
\gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'target_database', :'target_username')
\gexec
SQL
${psqlFailure('PostgreSQL database creation failed')}
if ! PGDATABASE="$TARGET_DATABASE" psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv target_username TARGET_USERNAME
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'target_username')
\gexec
SQL
${psqlFailure('PostgreSQL database privilege setup failed')}`;

const existingDatabaseScript = String.raw`${readiness}
if ! database_exists=$(psql -X --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 2>/dev/null <<'SQL'
\getenv target_database TARGET_DATABASE
SELECT 1 FROM pg_database
WHERE datname = :'target_database' AND datistemplate = false;
SQL
); then
  echo "PostgreSQL existing database check failed" >&2
  exit 1
fi
if [ "$database_exists" != "1" ]; then
  echo "POSTGRES_MANAGER_ERROR: database-not-found" >&2
  exit 44
fi
if ! psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv target_database TARGET_DATABASE
\getenv target_username TARGET_USERNAME
\getenv target_password TARGET_PASSWORD
SELECT format('CREATE ROLE %I', :'target_username')
\gexec
SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'target_username', :'target_password'
)
\gexec
${existingGrantSql}
SQL
${psqlFailure('PostgreSQL existing database validation failed')}
if ! PGDATABASE="$TARGET_DATABASE" psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
${broadDatabaseGrantSql}
SQL
${psqlFailure('PostgreSQL existing database privilege setup failed')}`;

const constrainedFullScript = String.raw`${readiness}
if ! psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv target_username TARGET_USERNAME
\getenv target_password TARGET_PASSWORD
SELECT format('CREATE ROLE %I', :'target_username')
\gexec
SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'target_username', :'target_password'
)
\gexec
SQL
${psqlFailure('PostgreSQL constrained full-access role creation failed')}
database_list=$(mktemp)
trap 'rm -f "$database_list"' EXIT
if ! psql -X --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  -c "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true" >"$database_list" 2>/dev/null; then
  echo "PostgreSQL database enumeration failed" >&2
  exit 1
fi
while IFS= read -r target_database; do
  if [ -z "$target_database" ]; then
    continue
  fi
  if ! TARGET_DATABASE="$target_database" PGDATABASE="$target_database" \
    psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
${existingGrantSql}
${broadDatabaseGrantSql}
SQL
  then
    echo "PostgreSQL full-access grant failed" >&2
    exit 1
  fi
done <"$database_list"`;

const superuserScript = String.raw`${readiness}
if ! psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv target_username TARGET_USERNAME
\getenv target_password TARGET_PASSWORD
SELECT format('CREATE ROLE %I', :'target_username')
\gexec
SELECT format(
  'ALTER ROLE %I WITH SUPERUSER LOGIN PASSWORD %L',
  :'target_username', :'target_password'
)
\gexec
SQL
${psqlFailure('PostgreSQL superuser role creation failed')}`;

const createdDatabaseCleanupScript = String.raw`${readiness}
if ! psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv target_database TARGET_DATABASE
\getenv target_username TARGET_USERNAME
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS false', :'target_database')
FROM pg_database AS database_record
JOIN pg_roles AS owner_role ON owner_role.oid = database_record.datdba
WHERE database_record.datname = :'target_database'
  AND owner_role.rolname = :'target_username'
\gexec
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'target_database' AND pid <> pg_backend_pid()
  AND EXISTS (
    SELECT 1
    FROM pg_database AS database_record
    JOIN pg_roles AS owner_role ON owner_role.oid = database_record.datdba
    WHERE database_record.datname = :'target_database'
      AND owner_role.rolname = :'target_username'
  );
SELECT format('DROP DATABASE %I', :'target_database')
FROM pg_database AS database_record
JOIN pg_roles AS owner_role ON owner_role.oid = database_record.datdba
WHERE database_record.datname = :'target_database'
  AND owner_role.rolname = :'target_username'
\gexec
SELECT format('REASSIGN OWNED BY %I TO CURRENT_USER', :'target_username')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SELECT format('DROP OWNED BY %I', :'target_username')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SELECT format('DROP ROLE %I', :'target_username')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SQL
${psqlFailure('PostgreSQL created database cleanup failed')}`;

const roleCleanupSql = String.raw`\getenv target_username TARGET_USERNAME
SELECT format('REASSIGN OWNED BY %I TO CURRENT_USER', :'target_username')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SELECT format('DROP OWNED BY %I', :'target_username')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec`;

const roleOnlyCleanupScript = String.raw`${readiness}
database_list=$(mktemp)
trap 'rm -f "$database_list"' EXIT
if ! psql -X --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  -c "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true AND has_database_privilege(current_user, datname, 'CONNECT')" \
  >"$database_list" 2>/dev/null; then
  echo "PostgreSQL accessible database enumeration failed" >&2
  exit 1
fi
while IFS= read -r target_database; do
  if [ -z "$target_database" ]; then
    continue
  fi
  if ! TARGET_DATABASE="$target_database" PGDATABASE="$target_database" \
    psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
${roleCleanupSql}
SQL
  then
    echo "PostgreSQL role cleanup failed" >&2
    exit 1
  fi
done <"$database_list"
if ! psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv target_username TARGET_USERNAME
SELECT format('DROP ROLE %I', :'target_username')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SQL
${psqlFailure('PostgreSQL role cleanup failed')}`;

function assertNonBlank(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${label}`);
  }
}

function validateAdministrator(administrator: AdminCredentials): void {
  if (typeof administrator !== 'object' || administrator === null) {
    throw new Error('Invalid administrator credentials');
  }
  assertNonBlank(administrator.username, 'administrator username');
  if (administrator.username.includes('\0')) throw new Error('Invalid administrator username');
  assertNonBlank(administrator.password, 'administrator password');
}

function validateLogin(login: LoginCredentials): void {
  if (typeof login !== 'object' || login === null || !USERNAME_PATTERN.test(login.username)) {
    throw new Error('Invalid login username');
  }
  assertNonBlank(login.password, 'login password');
}

function validateDatabase(database: string): void {
  assertNonBlank(database, 'database');
  if (
    database.includes('\0') ||
    database.toLowerCase() === 'template0' ||
    database.toLowerCase() === 'template1' ||
    new TextEncoder().encode(database).length > 63
  ) {
    throw new Error('Invalid database');
  }
}

function validateAccess(access: AccessRequest): void {
  if (access.scope === 'database') {
    validateDatabase(access.database);
    return;
  }
  if (typeof access.superuser !== 'boolean') {
    throw new Error('Invalid full-access request');
  }
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

function service(
  administrator: AdminCredentials,
  login: LoginCredentials,
  platform: PlatformConnection,
  mode: string,
  script: string,
  targetDatabase = 'postgres',
): RunnerMetadata {
  validateAdministrator(administrator);
  validateLogin(login);
  const validatedPlatform = parsePlatformConnection(platform);
  return {
    services: {
      'postgres-admin': {
        image: 'postgres:15',
        role: 'runner',
        connections: [validatedPlatform],
        environment: {
          ...adminEnvironment(administrator),
          ACCESS_MODE: mode,
          TARGET_DATABASE: targetDatabase,
          TARGET_USERNAME: login.username,
          TARGET_PASSWORD: login.password,
        },
        command: ['sh', '-ceu', script],
      },
    },
  };
}

export function buildAccessService(
  access: AccessRequest,
  administrator: AdminCredentials,
  login: LoginCredentials,
  platform: PlatformConnection,
): RunnerMetadata {
  validateAccess(access);
  if (access.scope === 'database') {
    const script = access.operation === 'create' ? createDatabaseScript : existingDatabaseScript;
    return service(
      administrator,
      login,
      platform,
      `${access.operation}-database`,
      script,
      access.database,
    );
  }
  if (access.superuser) {
    return service(administrator, login, platform, 'full-superuser', superuserScript);
  }
  return service(administrator, login, platform, 'full-constrained', constrainedFullScript);
}

export function buildCleanupService(
  access: AccessRequest,
  administrator: AdminCredentials,
  login: LoginCredentials,
  platform: PlatformConnection,
): RunnerMetadata {
  validateAccess(access);
  const script =
    access.scope === 'database' && access.operation === 'create'
      ? createdDatabaseCleanupScript
      : roleOnlyCleanupScript;
  const targetDatabase = access.scope === 'database' ? access.database : 'postgres';
  const mode =
    access.scope === 'database'
      ? `${access.operation}-database`
      : `full-${access.superuser ? 'superuser' : 'constrained'}`;
  return service(administrator, login, platform, mode, script, targetDatabase);
}

export type { DatabaseAccess, FullAccess };
