// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { buildAccessService, buildCleanupService } from './postgresAccessPlans';
import { generateLoginCredentials } from './credentials';
import type { AccessRequest } from './postgresConnectionRequest';
import type { PlatformConnection, RunnerService } from './postgresContracts';

const container = process.env.POSTGRES_INTEGRATION_CONTAINER;
const password = process.env.POSTGRES_INTEGRATION_PASSWORD ?? 'integration_only_password';
const platform: PlatformConnection = { type: 'Platform', data: { network: 'integration-network' } };
const administrator = {
  username: process.env.POSTGRES_INTEGRATION_USER ?? 'integration_admin',
  password,
};

interface CommandResult {
  stdout: string;
  stderr: string;
}

function runDocker(args: string[], input = ''): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', () => reject(new Error('Docker is unavailable')));
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Docker command failed with status ${code ?? 'unknown'}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

function serviceArgs(service: RunnerService): string[] {
  const environment = { ...service.environment, PGHOST: '127.0.0.1' };
  return [
    'exec',
    '-i',
    ...Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    container!,
    ...service.command!,
  ];
}

async function query(sql: string): Promise<string> {
  return queryAs(administrator.username, administrator.password, 'postgres', sql);
}

async function queryAs(
  username: string,
  userPassword: string,
  database: string,
  sql: string,
): Promise<string> {
  const result = await runDocker([
    'exec',
    '-i',
    '-e',
    `PGPASSWORD=${userPassword}`,
    container!,
    'psql',
    '-X',
    '-At',
    '-U',
    username,
    '-d',
    database,
    '-c',
    sql,
  ]);
  return result.stdout.trim();
}

function testLogin(seed: number) {
  return generateLoginCredentials((length) => new Uint8Array(length).fill(seed));
}

async function runAccess(access: AccessRequest, seed: number): Promise<CommandResult> {
  const login = testLogin(seed);
  const service = buildAccessService(access, administrator, login, platform).services?.[
    'postgres-admin'
  ];
  if (!service) throw new Error('Access service is missing');
  return runDocker(serviceArgs(service));
}

async function cleanupAccess(access: AccessRequest, seed: number): Promise<CommandResult> {
  const login = testLogin(seed);
  const service = buildCleanupService(access, administrator, login, platform).services?.[
    'postgres-admin'
  ];
  if (!service) throw new Error('Cleanup service is missing');
  return runDocker(serviceArgs(service));
}

describe.skipIf(!container)('opt-in PostgreSQL access-mode integration', () => {
  it('creates a new database and removes it during created-database cleanup', async () => {
    const database = `db_it_create_${Date.now()}`;
    const access = { scope: 'database', operation: 'create', database } as const;
    const login = testLogin(7);
    const output = await runAccess(access, 7);

    expect(`${output.stdout}\n${output.stderr}`).not.toContain(password);
    expect(`${output.stdout}\n${output.stderr}`).not.toContain(login.password);
    expect(
      await query(`SELECT datdba::regrole::text FROM pg_database WHERE datname = '${database}'`),
    ).toBe(login.username);
    await cleanupAccess(access, 7);
    expect(await query(`SELECT count(*) FROM pg_database WHERE datname = '${database}'`)).toBe('0');
    expect(await query(`SELECT count(*) FROM pg_roles WHERE rolname = '${login.username}'`)).toBe(
      '0',
    );
  }, 180_000);

  it('grants access to an existing database without changing its owner', async () => {
    const database = `db_it_existing_${Date.now()}`;
    const access = { scope: 'database', operation: 'existing', database } as const;
    await query(`CREATE DATABASE "${database}"`);
    try {
      await runAccess(access, 8);
      const login = testLogin(8);
      expect(
        await query(`SELECT datdba::regrole::text FROM pg_database WHERE datname = '${database}'`),
      ).toBe(administrator.username);
      expect(
        await query(`SELECT has_database_privilege('${login.username}', '${database}', 'CREATE')`),
      ).toBe('t');
      await queryAs(
        login.username,
        login.password,
        database,
        'CREATE TABLE cleanup_marker (id integer PRIMARY KEY)',
      );
      await cleanupAccess(access, 8);
      expect(await query(`SELECT count(*) FROM pg_roles WHERE rolname = '${login.username}'`)).toBe(
        '0',
      );
      expect(await query(`SELECT count(*) FROM pg_database WHERE datname = '${database}'`)).toBe(
        '1',
      );
    } finally {
      await query(`DROP DATABASE IF EXISTS "${database}"`);
    }
  }, 180_000);

  it('rejects a new-database collision without changing its owner', async () => {
    const database = `db_it_collision_${Date.now()}`;
    const access = { scope: 'database', operation: 'create', database } as const;
    await query(`CREATE DATABASE "${database}"`);
    try {
      await expect(runAccess(access, 9)).rejects.toThrow();
      expect(
        await query(`SELECT datdba::regrole::text FROM pg_database WHERE datname = '${database}'`),
      ).toBe(administrator.username);
    } finally {
      await query(`DROP DATABASE IF EXISTS "${database}"`);
    }
  }, 180_000);

  it('creates constrained full access with CREATEDB but not SUPERUSER', async () => {
    const access = { scope: 'full', superuser: false } as const;
    const login = testLogin(10);
    await runAccess(access, 10);
    try {
      expect(await query(`SELECT rolsuper FROM pg_roles WHERE rolname = '${login.username}'`)).toBe(
        'f',
      );
      expect(
        await query(`SELECT rolcreatedb FROM pg_roles WHERE rolname = '${login.username}'`),
      ).toBe('t');
    } finally {
      await cleanupAccess(access, 10);
      expect(await query(`SELECT count(*) FROM pg_roles WHERE rolname = '${login.username}'`)).toBe(
        '0',
      );
    }
  }, 180_000);

  it('creates a dedicated superuser without reusing the administrator', async () => {
    const access = { scope: 'full', superuser: true } as const;
    const login = testLogin(11);
    await runAccess(access, 11);
    try {
      expect(await query(`SELECT rolsuper FROM pg_roles WHERE rolname = '${login.username}'`)).toBe(
        't',
      );
      expect(login.username).not.toBe(administrator.username);
    } finally {
      await cleanupAccess(access, 11);
      expect(await query(`SELECT count(*) FROM pg_roles WHERE rolname = '${login.username}'`)).toBe(
        '0',
      );
    }
  }, 180_000);
});
