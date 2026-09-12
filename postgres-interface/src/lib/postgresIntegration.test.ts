// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { buildCleanupPlan, buildProvisionPlan } from './postgresPlans';
import { generateConnectionCredentials } from './credentials';
import type { PlatformConnection } from './postgresContracts';

const container = process.env.POSTGRES_INTEGRATION_CONTAINER;
const password = process.env.POSTGRES_INTEGRATION_PASSWORD ?? 'integration_only_password';
const platform: PlatformConnection = { type: 'Platform', data: { network: 'integration-network' } };
const administrator = { username: 'integration_admin', password };
const logical = {
  ...generateConnectionCredentials((length) => new Uint8Array(length).fill(7)),
  password: 'integration_logical_password',
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
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', () => reject(new Error('Docker is unavailable')));
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Docker command failed with status ${code ?? 'unknown'}`));
    });
    child.stdin.end(input);
  });
}

function serviceArgs(command: string[]): string[] {
  const environment = {
    PGHOST: '127.0.0.1',
    PGPORT: '5432',
    PGDATABASE: 'postgres',
    PGUSER: administrator.username,
    PGPASSWORD: administrator.password,
    TARGET_DATABASE: logical.database,
    TARGET_USERNAME: logical.username,
    TARGET_PASSWORD: logical.password,
  };
  return [
    'exec', '-i', ...Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    container!, ...command,
  ];
}

async function query(sql: string): Promise<string> {
  const result = await runDocker([
    'exec', '-i', '-e', `PGPASSWORD=${administrator.password}`, container!,
    'psql', '-X', '-At', '-U', administrator.username, '-d', 'postgres', '-c', sql,
  ]);
  return result.stdout.trim();
}

describe.skipIf(!container)('opt-in PostgreSQL provisioning integration', () => {
  it('provisions idempotently, scopes privileges, and cleans up', async () => {
    const provision = buildProvisionPlan(administrator, logical, platform);
    const service = provision.services?.['postgres-admin'];
    if (!service) throw new Error('Provisioning service is missing');
    const command = service.command;

    const first = await runDocker(serviceArgs(command!));
    const second = await runDocker(serviceArgs(command!));
    const provisionOutput = `${first.stdout}\n${first.stderr}\n${second.stdout}\n${second.stderr}`;
    expect(provisionOutput).not.toContain(password);
    expect(provisionOutput).not.toContain(logical.password);

    expect(await query(`SELECT rolname FROM pg_roles WHERE rolname = '${logical.username}'`)).toBe(logical.username);
    expect(await query(`SELECT datname FROM pg_database WHERE datname = '${logical.database}'`)).toBe(logical.database);
    expect(await query(`SELECT datdba::regrole::text FROM pg_database WHERE datname = '${logical.database}'`)).toBe(logical.username);
    expect(await query(`SELECT has_database_privilege('${logical.username}', '${logical.database}', 'CREATE')`)).toBe('t');

    const cleanup = buildCleanupPlan(administrator, logical.database, logical.username, platform);
    const cleanupService = cleanup.services?.['postgres-admin'];
    if (!cleanupService) throw new Error('Cleanup service is missing');
    const cleanupCommand = cleanupService.command;
    const removed = await runDocker(serviceArgs(cleanupCommand!));
    const cleanupOutput = `${removed.stdout}\n${removed.stderr}`;
    expect(cleanupOutput).not.toContain(password);
    expect(cleanupOutput).not.toContain(logical.password);
    expect(await query(`SELECT count(*) FROM pg_roles WHERE rolname = '${logical.username}'`)).toBe('0');
    expect(await query(`SELECT count(*) FROM pg_database WHERE datname = '${logical.database}'`)).toBe('0');
  }, 180_000);
});
