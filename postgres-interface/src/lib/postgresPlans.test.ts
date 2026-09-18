import { describe, expect, it } from 'vitest';
import type { LogicalCredentials } from './legacyCredentials';
import type { PlatformConnection } from './postgresContracts';
import {
  buildCleanupPlan,
  buildConnectionMetadata,
  buildProvisionPlan,
  CLEANUP_SCRIPT,
  PROVISION_SCRIPT,
} from './postgresPlans';

const administrator = { username: 'dc_admin_0123456789abcdef0123456789abcdef', password: 'admin-secret' };
const logical: LogicalCredentials = {
  database: 'db_0123456789abcdef0123456789abcdef',
  username: 'dc_user_0123456789abcdef0123456789abcdef',
  password: 'logical-secret',
};
const platform: PlatformConnection = {
  type: 'Platform',
  data: { network: 'postgres-network' },
};

describe('postgres administration plans', () => {
  it('builds an isolated runner-only provisioning plan with environment-bound values', () => {
    const plan = buildProvisionPlan(administrator, logical, platform);
    expect(plan).toEqual({
      services: {
        'postgres-admin': {
          image: 'postgres:15',
          role: 'runner',
          connections: [platform],
          environment: {
            PGHOST: 'postgres',
            PGPORT: '5432',
            PGDATABASE: 'postgres',
            PGUSER: administrator.username,
            PGPASSWORD: administrator.password,
            TARGET_DATABASE: logical.database,
            TARGET_USERNAME: logical.username,
            TARGET_PASSWORD: logical.password,
          },
          command: ['sh', '-ceu', PROVISION_SCRIPT],
        },
      },
    });
    expect(plan.services?.postgres).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain('PostgreSQL provisioning failed:');
    expect(PROVISION_SCRIPT).not.toContain(administrator.password);
    expect(PROVISION_SCRIPT).not.toContain(logical.password);
  });

  it('uses the complete fixed provisioning script and safe SQL generation', () => {
    expect(PROVISION_SCRIPT).toBe(`attempt=1
while ! pg_isready -q; do
  if [ "$attempt" -ge 60 ]; then
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if ! psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\\getenv target_database TARGET_DATABASE
\\getenv target_username TARGET_USERNAME
\\getenv target_password TARGET_PASSWORD
SELECT format('CREATE ROLE %I', :'target_username')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\\gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'target_username', :'target_password')
\\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'target_database', :'target_username')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_database')
\\gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'target_database', :'target_username')
\\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', :'target_database')
\\gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'target_database', :'target_username')
\\gexec
SQL
then
  echo "PostgreSQL provisioning failed" >&2
  exit 1
fi
if ! PGDATABASE="$TARGET_DATABASE" psql -X --quiet --set=ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
\\getenv target_username TARGET_USERNAME
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'target_username')
\\gexec
SQL
then
  echo "PostgreSQL provisioning failed" >&2
  exit 1
fi`);
    expect(PROVISION_SCRIPT).toContain('if [ "$attempt" -ge 60 ]');
    expect(PROVISION_SCRIPT).toContain('sleep 2');
    expect(PROVISION_SCRIPT).toContain('>/dev/null 2>&1');
    expect(PROVISION_SCRIPT).toContain("format('CREATE ROLE %I'");
    expect(PROVISION_SCRIPT).toContain("PASSWORD %L");
    expect(PROVISION_SCRIPT).toContain('\\getenv');
    expect(PROVISION_SCRIPT).toContain('\\gexec');
    expect(PROVISION_SCRIPT).not.toContain('set -x');
    expect(PROVISION_SCRIPT).not.toMatch(/SELECT format\([^\n]+\);\n\\gexec/);
  });

  it('builds cleanup with session termination and fixed safe drop statements', () => {
    const plan = buildCleanupPlan(administrator, logical.database, logical.username, platform);
    expect(plan).toEqual({
      services: {
        'postgres-admin': {
          image: 'postgres:15',
          role: 'runner',
          connections: [platform],
          environment: {
            PGHOST: 'postgres',
            PGPORT: '5432',
            PGDATABASE: 'postgres',
            PGUSER: administrator.username,
            PGPASSWORD: administrator.password,
            TARGET_DATABASE: logical.database,
            TARGET_USERNAME: logical.username,
          },
          command: ['sh', '-ceu', CLEANUP_SCRIPT],
        },
      },
    });
    expect(CLEANUP_SCRIPT).toContain('pg_terminate_backend(pid)');
    expect(CLEANUP_SCRIPT).toContain("DROP DATABASE IF EXISTS %I");
    expect(CLEANUP_SCRIPT).toContain("DROP ROLE IF EXISTS %I");
    expect(CLEANUP_SCRIPT).toContain('PostgreSQL cleanup failed');
    expect(CLEANUP_SCRIPT).not.toContain(administrator.password);
  });

  it('returns runner-ready logical connection metadata', () => {
    expect(buildConnectionMetadata(logical, platform)).toEqual({
      host: 'postgres',
      port: 5432,
      database: logical.database,
      username: logical.username,
      password: logical.password,
      platform_connection: platform,
    });
    expect(buildConnectionMetadata(logical, platform)).not.toHaveProperty('PGUSER');
    expect(buildConnectionMetadata(logical, platform)).not.toHaveProperty('PGPASSWORD');
  });

  it('rejects malformed platform data before building connection metadata', () => {
    expect(() => buildConnectionMetadata(logical, {
      type: 'Platform', data: { network: '   ' },
    })).toThrow('Invalid platform connection');
  });

  it('rejects an administrator username in the reserved PostgreSQL namespace', () => {
    expect(() => buildProvisionPlan({
      ...administrator,
      username: 'pg_admin_0123456789abcdef0123456789abcdef',
    }, logical, platform)).toThrow('Invalid administrator username');
  });

  it.each([
    { ...logical, database: 'db;drop database postgres' },
    { ...logical, username: 'pg_user;drop role postgres' },
    { ...logical, username: 'pg_user_0123456789abcdef0123456789abcdef' },
    { ...logical, password: '' },
    ])('rejects unsafe logical credentials %j', (unsafe) => {
    expect(() => buildProvisionPlan(administrator, unsafe, platform)).toThrow();
  });
});
