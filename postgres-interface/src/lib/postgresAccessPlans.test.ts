import { describe, expect, it } from 'vitest';
import type { AdminCredentials } from './credentials';
import type { PlatformConnection } from './postgresContracts';
import { buildAccessService, buildCleanupService } from './postgresAccessPlans';

const administrator: AdminCredentials = {
  username: 'dc_admin_0123456789abcdef0123456789abcdef',
  password: 'administrator-secret',
};
const login = {
  username: 'dc_user_fedcba9876543210fedcba9876543210',
  password: 'logical-secret',
};
const platform: PlatformConnection = {
  type: 'Platform',
  data: { network: 'postgres-network' },
};

describe('postgres access plans', () => {
  it.each([
    [{ scope: 'database', operation: 'create', database: 'orders' }, 'create-database'],
    [{ scope: 'database', operation: 'existing', database: 'warehouse' }, 'existing-database'],
    [{ scope: 'full', superuser: false }, 'full-constrained'],
    [{ scope: 'full', superuser: true }, 'full-superuser'],
  ] as const)('builds the %s access runner service', (access, expectedMode) => {
    const plan = buildAccessService(access, administrator, login, platform);
    expect(plan.services?.['postgres-admin']).toMatchObject({
      image: 'postgres:15',
      role: 'runner',
      connections: [platform],
      environment: {
        ACCESS_MODE: expectedMode,
        TARGET_USERNAME: login.username,
        TARGET_PASSWORD: login.password,
      },
    });
  });

  it('fails on a new-database collision without changing its owner', () => {
    const service = buildAccessService(
      { scope: 'database', operation: 'create', database: 'orders' },
      administrator,
      login,
      platform,
    ).services?.['postgres-admin'];
    const script = service?.command?.[2] ?? '';

    expect(script).toContain('1 / 0');
    expect(script).not.toContain('ALTER DATABASE %I OWNER');
    expect(script).toContain('CREATE DATABASE %I OWNER %I');
  });

  it('verifies existing databases without dropping or taking ownership', () => {
    const service = buildAccessService(
      { scope: 'database', operation: 'existing', database: 'warehouse' },
      administrator,
      login,
      platform,
    ).services?.['postgres-admin'];
    const script = service?.command?.[2] ?? '';

    expect(script).toContain('datistemplate = false');
    expect(script).toContain('GRANT CONNECT, TEMPORARY, CREATE');
    expect(script).toContain('GRANT ALL PRIVILEGES ON ALL TABLES');
    expect(script).not.toContain('DROP DATABASE');
    expect(script).not.toContain('ALTER DATABASE %I OWNER');
  });

  it('creates a constrained full-access login with explicit restrictions', () => {
    const service = buildAccessService(
      { scope: 'full', superuser: false },
      administrator,
      login,
      platform,
    ).services?.['postgres-admin'];
    const script = service?.command?.[2] ?? '';

    expect(script).toContain('CREATEDB');
    expect(script).toContain('NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    expect(script).toContain('datistemplate = false');
  });

  it('creates a dedicated superuser login', () => {
    const service = buildAccessService(
      { scope: 'full', superuser: true },
      administrator,
      login,
      platform,
    ).services?.['postgres-admin'];
    const script = service?.command?.[2] ?? '';

    expect(script).toContain('SUPERUSER LOGIN PASSWORD');
    expect(script).not.toContain(administrator.password);
  });

  it('uses database cleanup for created databases and role-only cleanup otherwise', () => {
    const created =
      buildCleanupService(
        { scope: 'database', operation: 'create', database: 'orders' },
        administrator,
        login,
        platform,
      ).services?.['postgres-admin']?.command?.[2] ?? '';
    const existing =
      buildCleanupService(
        { scope: 'database', operation: 'existing', database: 'warehouse' },
        administrator,
        login,
        platform,
      ).services?.['postgres-admin']?.command?.[2] ?? '';
    const full =
      buildCleanupService({ scope: 'full', superuser: false }, administrator, login, platform)
        .services?.['postgres-admin']?.command?.[2] ?? '';

    expect(created).toContain('DROP DATABASE');
    expect(created.indexOf('DROP DATABASE')).toBeLessThan(created.indexOf('DROP ROLE'));
    expect(existing).not.toContain('DROP DATABASE');
    expect(full).not.toContain('DROP DATABASE');
    expect(existing).toContain('REASSIGN OWNED');
    expect(full).toContain('DROP OWNED');
  });

  it('does not embed credentials or enable shell tracing', () => {
    const plan = buildAccessService(
      { scope: 'database', operation: 'create', database: 'orders' },
      administrator,
      login,
      platform,
    );
    const cleanup = buildCleanupService(
      { scope: 'database', operation: 'create', database: 'orders' },
      administrator,
      login,
      platform,
    );
    const scripts = [plan, cleanup]
      .flatMap((item) => Object.values(item.services ?? {}))
      .map((service) => service.command?.[2] ?? '')
      .join('\n');

    expect(scripts).not.toContain(administrator.password);
    expect(scripts).not.toContain(login.password);
    expect(scripts).not.toContain('set -x');
  });
});
