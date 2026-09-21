import type { LoginCredentials } from '../domain/credentials';
import { connectionLabels, type DatabaseOrigin, type DeletionEffect } from '../domain/labels';
import type { AccessRequest } from '../domain/requests';
import type { PostgresConnection } from './connections';
import type { PostgresInstallation } from './resources';

export const RUNNER_IMAGE = 'ezenki/deploy-commander-runner:latest';
export const POSTGRES_IMAGE = 'postgres:15';
export const POSTGRES_NETWORK_GROUP = 'postgres-internal';

type RunnerService = {
  image: string;
  role?: 'runner';
  aliases?: string[];
  network_groups?: string[];
  environment?: Record<string, string>;
  command?: string[];
  connections?: Array<{ type: 'Platform'; data: { network: string } }>;
  resources?: Array<Record<string, unknown>>;
  volumes?: Array<{ name: string; mount_path: string }>;
};

type ConnectionCreate = {
  name: string;
  manager: string;
  resource: { id: string };
  metadata: Record<string, unknown>;
  labels: Record<string, string>;
};

type ConnectionRemove = { name: string; id: string; resource: { id: string } };

export type RunnerMetadata = {
  services?: Record<string, RunnerService>;
  volumes?: string[];
  connections?: { create?: ConnectionCreate[]; remove?: ConnectionRemove[] };
};

const readiness = String.raw`log() {
  printf '%s\n' "$1"
}
fail() {
  printf '%s\n' "POSTGRES_MANAGER_ERROR: $1" >&2
  exit "$2"
}
if [ -z "$PGCONNECT_TIMEOUT" ]; then PGCONNECT_TIMEOUT=5; fi
export PGCONNECT_TIMEOUT
trap 'status=$?; if [ "$status" -eq 0 ]; then log "POSTGRES_MANAGER: postgres-admin completed"; else printf "%s\\n" "POSTGRES_MANAGER_ERROR: postgres-admin failed (exit $status)" >&2; fi' EXIT
log "POSTGRES_MANAGER: postgres-admin started"
log "POSTGRES_MANAGER: waiting for PostgreSQL"
attempt=1
while ! pg_isready -q; do
  if [ "$attempt" -ge 60 ]; then
    echo "POSTGRES_MANAGER_ERROR: postgres-unavailable" >&2
    exit 47
  fi
  attempt=$((attempt + 1))
  sleep 2
done
log "POSTGRES_MANAGER: PostgreSQL ready"`;

const roleSetup = String.raw`\getenv target_username TARGET_USERNAME
\getenv target_password TARGET_PASSWORD
SELECT format('CREATE ROLE %I', :'target_username')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'target_username', :'target_password'
)
\gexec`;

export const DATABASE_PROVISION_SCRIPT = String.raw`${readiness}
log "POSTGRES_MANAGER: configuring database role"
if ! psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\getenv database_owner DATABASE_OWNER
SELECT format('CREATE ROLE %I NOLOGIN', :'database_owner')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'database_owner')
\gexec
${roleSetup}
SQL
then fail "postgres-role-setup-failed" 41; fi
log "POSTGRES_MANAGER: checking database ownership"
database_owner=$(psql -X --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 <<'SQL'
\getenv target_database TARGET_DATABASE
SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = :'target_database';
SQL
)
if [ -z "$database_owner" ]; then
  log "POSTGRES_MANAGER: creating database"
  psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL' || fail "postgres-database-create-failed" 42
\getenv target_database TARGET_DATABASE
\getenv database_owner DATABASE_OWNER
SELECT format('CREATE DATABASE %I OWNER %I', :'target_database', :'database_owner')
\gexec
SQL
elif [ "$database_owner" != "$DATABASE_OWNER" ]; then
  echo "POSTGRES_MANAGER_ERROR: database-collision" >&2
  exit 45
fi
log "POSTGRES_MANAGER: granting database access"
PGDATABASE="$TARGET_DATABASE" psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL' || fail "postgres-grants-failed" 43
\getenv target_database TARGET_DATABASE
\getenv target_username TARGET_USERNAME
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'target_database', :'target_username')
\gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'target_username')
\gexec
SQL
exit 0`;

export const EXISTING_DATABASE_SCRIPT = String.raw`${readiness}
log "POSTGRES_MANAGER: checking requested database"
database_exists=$(psql -X --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 <<'SQL'
\getenv target_database TARGET_DATABASE
SELECT 1 FROM pg_database WHERE datname = :'target_database' AND datistemplate = false AND datallowconn = true;
SQL
)
if [ "$database_exists" != "1" ]; then
  echo "POSTGRES_MANAGER_ERROR: database-not-found" >&2
  exit 44
fi
log "POSTGRES_MANAGER: configuring database role"
psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL' || fail "postgres-role-setup-failed" 41
${roleSetup}
\getenv target_database TARGET_DATABASE
\getenv target_username TARGET_USERNAME
SELECT format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO %I', :'target_database', :'target_username')
\gexec
SQL
log "POSTGRES_MANAGER: granting database access"
PGDATABASE="$TARGET_DATABASE" psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL' || fail "postgres-grants-failed" 43
\getenv target_username TARGET_USERNAME
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
SQL
exit 0`;

export const CONSTRAINED_FULL_SCRIPT = String.raw`${readiness}
log "POSTGRES_MANAGER: configuring full-access role"
psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL' || fail "postgres-role-setup-failed" 41
\getenv target_username TARGET_USERNAME
\getenv target_password TARGET_PASSWORD
SELECT format('CREATE ROLE %I', :'target_username')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SELECT format('ALTER ROLE %I WITH CREATEDB LOGIN PASSWORD %L NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'target_username', :'target_password')
\gexec
SQL
databases=$(psql -X --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 -c "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true") || fail "postgres-database-list-failed" 42
log "POSTGRES_MANAGER: granting database access"
printf '%s\n' "$databases" | while IFS= read -r TARGET_DATABASE; do
  [ -z "$TARGET_DATABASE" ] && continue
  PGDATABASE="$TARGET_DATABASE" psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL' || fail "postgres-grants-failed" 43
\getenv target_username TARGET_USERNAME
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', current_database(), :'target_username')
\gexec
SQL
done || fail "postgres-grants-failed" 43
exit 0`;

export const SUPERUSER_SCRIPT = String.raw`${readiness}
log "POSTGRES_MANAGER: configuring superuser role"
psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL' || fail "postgres-role-setup-failed" 41
\getenv target_username TARGET_USERNAME
\getenv target_password TARGET_PASSWORD
SELECT format('CREATE ROLE %I', :'target_username')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SELECT format('ALTER ROLE %I WITH SUPERUSER LOGIN PASSWORD %L', :'target_username', :'target_password')
\gexec
SQL
exit 0`;

export const ROLE_CLEANUP_SCRIPT = String.raw`${readiness}
log "POSTGRES_MANAGER: listing databases for cleanup"
databases=$(psql -X --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 -c "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true") || fail "postgres-database-list-failed" 42
log "POSTGRES_MANAGER: removing role ownership"
printf '%s\n' "$databases" | while IFS= read -r TARGET_DATABASE; do
  [ -z "$TARGET_DATABASE" ] && continue
  PGDATABASE="$TARGET_DATABASE" psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL' || fail "postgres-cleanup-failed" 43
\getenv target_username TARGET_USERNAME
SELECT format('REASSIGN OWNED BY %I TO CURRENT_USER', :'target_username')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SELECT format('DROP OWNED BY %I', :'target_username')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SQL
done || fail "postgres-cleanup-failed" 43
psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL' || fail "postgres-role-drop-failed" 44
\getenv target_username TARGET_USERNAME
SELECT format('DROP ROLE %I', :'target_username')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SQL
exit 0`;

export const DATABASE_CLEANUP_SCRIPT = String.raw`${readiness}
log "POSTGRES_MANAGER: checking database ownership"
owner=$(psql -X --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 <<'SQL'
\getenv target_database TARGET_DATABASE
SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = :'target_database';
SQL
)
if [ -n "$owner" ] && [ "$owner" != "$DATABASE_OWNER" ]; then
  echo "POSTGRES_MANAGER_ERROR: database-owner-mismatch" >&2
  exit 46
fi
log "POSTGRES_MANAGER: removing database and roles"
psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL' || fail "postgres-database-cleanup-failed" 43
\getenv target_database TARGET_DATABASE
\getenv target_username TARGET_USERNAME
\getenv database_owner DATABASE_OWNER
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS false', :'target_database')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_database')
\gexec
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname = :'target_database' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE %I', :'target_database')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_database')
\gexec
SELECT format('DROP ROLE %I', :'target_username')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SELECT format('DROP ROLE %I', :'database_owner')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'database_owner')
\gexec
SQL
exit 0`;

function adminEnvironment(installation: PostgresInstallation): Record<string, string> {
  return {
    PGHOST: 'postgres',
    PGPORT: '5432',
    PGDATABASE: 'postgres',
    PGUSER: installation.administrator.username,
    PGPASSWORD: installation.administrator.password,
    PGCONNECT_TIMEOUT: '5',
  };
}

function adminService(
  installation: PostgresInstallation,
  environment: Record<string, string>,
  script: string,
): RunnerService {
  return {
    image: POSTGRES_IMAGE,
    role: 'runner',
    network_groups: [POSTGRES_NETWORK_GROUP],
    environment: { ...adminEnvironment(installation), ...environment },
    command: ['sh', '-ceu', script],
  };
}

function loginEnvironment(
  installation: PostgresInstallation,
  login: LoginCredentials,
  database: string,
  databaseOwner?: string,
): Record<string, string> {
  return {
    TARGET_DATABASE: database,
    TARGET_USERNAME: login.username,
    TARGET_PASSWORD: login.password,
    ...(databaseOwner ? { DATABASE_OWNER: databaseOwner } : {}),
  };
}

function accessScript(access: AccessRequest): string {
  if (access.scope === 'database')
    return access.operation === 'create' ? DATABASE_PROVISION_SCRIPT : EXISTING_DATABASE_SCRIPT;
  return access.superuser ? SUPERUSER_SCRIPT : CONSTRAINED_FULL_SCRIPT;
}

function connectionMetadata(
  login: LoginCredentials,
  access: AccessRequest,
): Record<string, unknown> {
  return {
    host: 'postgres',
    port: 5432,
    database: access.scope === 'database' ? access.database : 'postgres',
    username: login.username,
    password: login.password,
    access,
  };
}

export function buildInstallPlan(administrator: {
  username: string;
  password: string;
}): RunnerMetadata {
  return {
    services: {
      postgres: {
        image: POSTGRES_IMAGE,
        aliases: ['postgres'],
        network_groups: [POSTGRES_NETWORK_GROUP],
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
  };
}

export function buildTeardownPlan(): RunnerMetadata {
  return {};
}

export function buildProvisionPlan(input: {
  installation: PostgresInstallation;
  callerId: string;
  access: AccessRequest;
  origin?: DatabaseOrigin;
  login: LoginCredentials;
  databaseOwner?: string;
  callerLabels: Record<string, string>;
}): RunnerMetadata {
  const database = input.access.scope === 'database' ? input.access.database : 'postgres';
  if (input.access.scope === 'database' && !input.databaseOwner)
    throw new Error('Database owner is required');
  const labels = connectionLabels(input.access, input.callerLabels, input.origin);
  return {
    services: {
      'postgres-admin': adminService(
        input.installation,
        loginEnvironment(input.installation, input.login, database, input.databaseOwner),
        accessScript(input.access),
      ),
    },
    connections: {
      create: [
        {
          name: 'postgres-connection',
          manager: input.callerId,
          resource: { id: input.installation.resource.id },
          metadata: connectionMetadata(input.login, input.access),
          labels,
        },
      ],
    },
  };
}

export function buildDeletePlan(input: {
  installation: PostgresInstallation;
  target: PostgresConnection;
  effect: DeletionEffect;
  databaseOwner?: string;
}): RunnerMetadata {
  const database =
    input.target.authority.access === 'database' ? input.target.authority.database : 'postgres';
  if (
    input.effect === 'role-and-database' &&
    (!input.databaseOwner || input.target.authority.access !== 'database')
  ) {
    throw new Error('Managed database owner is required');
  }
  return {
    services: {
      'postgres-admin': adminService(
        input.installation,
        loginEnvironment(
          input.installation,
          { username: input.target.username, password: input.target.password },
          database,
          input.databaseOwner,
        ),
        input.effect === 'role-and-database' ? DATABASE_CLEANUP_SCRIPT : ROLE_CLEANUP_SCRIPT,
      ),
    },
    connections: {
      remove: [
        {
          name: 'postgres-connection',
          id: input.target.item.id,
          resource: { id: input.target.resourceId },
        },
      ],
    },
  };
}
