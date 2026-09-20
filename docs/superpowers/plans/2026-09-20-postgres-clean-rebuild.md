# PostgreSQL Manager Clean Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the PostgreSQL manager as a React/TypeScript interface whose durable state is derived only from Deploy Commander resources and connections, with mandatory approval for connection creation and deletion.

**Architecture:** Scaffold a new manager with the official initializer, then add small domain, platform, workflow, and React units. Resources project installation, connections project access, and one event tracker observes only active exact runs; runner-role `psql` services perform idempotent PostgreSQL changes without a manager database or recovery layer.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Vitest 4, Testing Library, `@ezenki/deploy-commander-installer-interface@^0.5.0`, standard Deploy Commander runner, PostgreSQL 15.

**Spec:** `docs/superpowers/specs/2026-09-19-postgres-clean-rebuild-design.md`

## Global Constraints

- Begin from commit `5db7345` or a descendant containing the approved specification.
- Run the official NPX initializer with React, TypeScript, manager name `postgres`, manager kind `postgres`, and npm; do not hand-build the initial project.
- Treat one non-external `postgres` resource named `postgres` as installed; never use a completed run to decide installation.
- Treat attached Deploy Commander connections and their labels as the only logical-access authority.
- Never call `databaseQuery`, use runner `object_hooks`, call `getLatestRun`, scan completed runs, or add recovery state/messages.
- Every create-connection and delete-connection request requires explicit approval before `caller.start`, connection mutation, or successful child close.
- The Install button itself is approval; do not add a second install confirmation.
- Use `run-start` and `run-update` events for exact-run progress, importing official status constants rather than hard-coding numbers.
- Preserve all request variants and successful response shapes documented by `POSTGRES_MANAGER_INTERFACE_GUIDE.md`.
- Only the final connection labeled as belonging to a manager-created database may cause that database to be dropped.
- Use `ezenki/deploy-commander-runner:latest` and `postgres:15`.
- Follow test-driven development for all non-generated production behavior: write a failing test, observe the intended failure, add minimal code, run the focused test and full suite, then commit.
- Never place credentials in run notes, errors, URLs, browser storage, logs, publishing JSON, or committed environment files.

## Review Focus

- More than 50 resources or connections: pagination must load every page before projecting state or deciding final-database cleanup; Task 3 tests both boundaries.
- Approval-time races: if the connection or its peers change after approval, deletion must fail `409` before a run; Task 7 tests this explicitly.
- Event ordering and replay: a matching `run-start` may precede the `start()` response while unrelated or duplicate updates must be ignored; Task 5 tests all three cases.
- Partial create retry and name collision: an existing database is reusable only when owned by the deterministic manager database-owner role; Task 4 tests the generated plan and collision branch.
- Malformed or contradictory reserved labels: deletion must preserve the database and return a concrete conflict; Tasks 3 and 7 test malformed targets.

---

## Planned File Structure

| File | Responsibility |
| --- | --- |
| `postgres-interface/src/domain/errors.ts` | Structured public workflow errors and defensive RPC error helpers |
| `postgres-interface/src/domain/requests.ts` | Strict create/delete metadata parsing and access types |
| `postgres-interface/src/domain/labels.ts` | Reserved labels, origin propagation, and deletion consequences |
| `postgres-interface/src/domain/credentials.ts` | Secure credentials and deterministic PostgreSQL role names |
| `postgres-interface/src/platform/resources.ts` | Paginated resource loading and detailed installation parsing |
| `postgres-interface/src/platform/connections.ts` | Paginated connection loading, detailed connection parsing, matching |
| `postgres-interface/src/platform/plans.ts` | Install, provision, cleanup, and teardown runner metadata |
| `postgres-interface/src/platform/runTracker.ts` | Exact active-run event buffering, state transitions, and catch-up |
| `postgres-interface/src/platform/interfaceClient.ts` | One wire, caller, event source, trusted context, and cleanup |
| `postgres-interface/src/workflows/createConnection.ts` | Approval-gated create workflow |
| `postgres-interface/src/workflows/deleteConnection.ts` | Approval-gated delete workflow |
| `postgres-interface/src/workflows/lifecycle.ts` | Direct install and confirmed teardown workflows |
| `postgres-interface/src/components/*` | Dashboard, approval dialogs, progress, and errors |
| `postgres-interface/src/app/App.tsx` | Root/child routing and interface close behavior |
| `postgres-interface/src/test/fakes.ts` | Typed RPC/event test doubles only |

### Task 1: Official React Manager Scaffold

**Files:**
- Create: `postgres-interface/` via the official initializer
- Verify/modify: `postgres-interface/package.json`
- Verify/modify: `postgres-interface/deploy-commander.json`
- Verify/modify: `postgres-interface/.env.example`
- Verify: `postgres-interface/.gitignore`
- Create: `postgres-interface/src/test/setup.ts`
- Modify: `postgres-interface/vite.config.ts`

**Interfaces:**
- Consumes: official NPX initializer documented in `docs/integrations/MANAGER_INTERFACE_GUIDE.md`
- Produces: an npm React/TypeScript project with `dev`, `build`, `test`, `lint`, `format:check`, `publish:manager`, and `deploy` commands

- [ ] **Step 1: Run the official initializer**

Run from the repository root:

```bash
npx @ezenki/deploy-commander-installer-interface init postgres-interface \
  --framework react \
  --language typescript \
  --manager-name postgres \
  --manager-kind postgres \
  --manager-description "Installs PostgreSQL and manages approval-gated database connections" \
  --package-manager npm
```

Expected: a new `postgres-interface` directory, dependencies installed, and generated build/publish/deploy commands. This generated scaffold is the TDD exception; do not add manager behavior in this step.

- [ ] **Step 2: Verify publishing configuration and environment separation**

Make `deploy-commander.json` exactly:

```json
{
  "name": "postgres",
  "kind": "postgres",
  "description": "Installs PostgreSQL and manages approval-gated database connections",
  "buildDirectory": "dist"
}
```

Make `.env.example` contain only:

```dotenv
COMMANDER_URL=
COMMANDER_USERNAME=
COMMANDER_PASSWORD=
```

Confirm `.env` is ignored. Do not add publishing labels or a Commander URL to JSON.

- [ ] **Step 3: Add the test harness without manager behavior**

Ensure these dev dependencies exist:

```bash
npm install --save-dev vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom prettier
```

Add scripts if the initializer did not generate them:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "format": "prettier --config ../.prettierrc.json --ignore-path ../.prettierignore --write . ../docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md",
    "format:check": "prettier --config ../.prettierrc.json --ignore-path ../.prettierignore --check . ../docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md"
  }
}
```

Configure Vitest in `vite.config.ts`:

```ts
test: {
  environment: 'jsdom',
  setupFiles: ['./src/test/setup.ts'],
  clearMocks: true,
},
```

Create `src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 4: Remove generated demo assets, not generated tool configuration**

Delete demo-only source such as logo assets and sample counters. Leave a minimal `main.tsx` that imports a temporary empty `App`; Task 9 replaces it with real interface startup. Do not copy files from commit `2b87fce` or any deleted manager tree.

- [ ] **Step 5: Verify the scaffold**

Run:

```bash
cd postgres-interface
npm run build
npm run lint
npm test
```

Expected: all commands succeed; no manager workflow behavior exists yet.

- [ ] **Step 6: Commit**

```bash
git add postgres-interface
git commit -m "chore: scaffold postgres manager interface"
```

### Task 2: Requests, Labels, Errors, and Credentials

**Files:**
- Create: `postgres-interface/src/domain/errors.ts`
- Create: `postgres-interface/src/domain/requests.ts`
- Create: `postgres-interface/src/domain/labels.ts`
- Create: `postgres-interface/src/domain/credentials.ts`
- Create: `postgres-interface/src/domain/requests.test.ts`
- Create: `postgres-interface/src/domain/labels.test.ts`
- Create: `postgres-interface/src/domain/credentials.test.ts`

**Interfaces:**
- Consumes: browser Web Crypto and untrusted `unknown` metadata
- Produces: `PostgresRequestError`, `AccessRequest`, `ParsedCreateRequest`, `ParsedDeleteRequest`, `parseCreateRequest`, `parseDeleteRequest`, `connectionLabels`, `parseConnectionLabels`, `databaseOrigin`, `deletionEffect`, `generateAdminCredentials`, `generateLoginCredentials`, `databaseOwnerRole`

- [ ] **Step 1: Write failing strict request-parser tests**

Create `requests.test.ts` with table-driven tests including:

```ts
import { describe, expect, it } from 'vitest';
import { parseCreateRequest, parseDeleteRequest } from './requests';

describe('parseCreateRequest', () => {
  it('accepts the published database-create request', () => {
    expect(parseCreateRequest({
      action: 'create-connection',
      scope: 'database',
      operation: 'create',
      database: 'orders',
      labels: { team: 'payments' },
    })).toEqual({
      action: 'create-connection',
      requestedAccess: { scope: 'database', operation: 'create', database: 'orders' },
      labels: { team: 'payments' },
    });
  });

  it.each([
    { action: 'create-connection', scope: 'database', operation: 'create' },
    { action: 'create-connection', scope: 'full' },
    { action: 'create-connection', extra: true },
    { action: 'create-connection', labels: { ' postgres.access ': 'full' } },
    { action: 'create-connection', scope: 'database', operation: 'create', database: 'template1' },
  ])('rejects invalid or incomplete metadata %#', (metadata) => {
    let thrown: unknown;
    try { parseCreateRequest(metadata); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ status: 400 });
  });
});

describe('parseDeleteRequest', () => {
  it('accepts selection and explicit-ID forms', () => {
    expect(parseDeleteRequest({ action: 'delete-connection' })).toEqual({
      action: 'delete-connection', connectionId: null,
    });
    expect(parseDeleteRequest({ action: 'delete-connection', connection: 'connection-1' }))
      .toEqual({ action: 'delete-connection', connectionId: 'connection-1' });
  });
});
```

- [ ] **Step 2: Run request tests and observe RED**

Run: `npm test -- src/domain/requests.test.ts`

Expected: FAIL because `requests.ts` does not exist.

- [ ] **Step 3: Implement errors and strict request parsing**

Define:

```ts
export class PostgresRequestError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 499 | 500, message: string) {
    super(message);
    this.name = 'PostgresRequestError';
  }
}

export type DatabaseAccess = {
  scope: 'database';
  operation: 'create' | 'existing';
  database: string;
};
export type FullAccess = { scope: 'full'; superuser: boolean };
export type AccessRequest = DatabaseAccess | FullAccess;
export type ParsedCreateRequest = {
  action: 'create-connection';
  requestedAccess: AccessRequest | null;
  labels: Record<string, string>;
};
export type ParsedDeleteRequest = {
  action: 'delete-connection';
  connectionId: string | null;
};
```

Use exact-key validation. Reject unknown keys, partial access groups, non-string labels, trimmed variants of reserved keys, blank IDs, NULs, UTF-8 names over 63 bytes, and `template0`/`template1` case-insensitively.

- [ ] **Step 4: Run focused and full tests GREEN**

Run:

```bash
npm test -- src/domain/requests.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 5: Write failing label/origin/deletion tests**

Create `labels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { connectionLabels, databaseOrigin, deletionEffect, parseConnectionLabels } from './labels';

it('adds all database authority labels without allowing caller override', () => {
  expect(connectionLabels(
    { scope: 'database', operation: 'create', database: 'orders' },
    { team: 'payments' },
    'managed',
  )).toEqual({
    team: 'payments',
    'postgres.access': 'database',
    'postgres.database': 'orders',
    'postgres.database-origin': 'managed',
  });
});

it('propagates managed origin from a current peer', () => {
  expect(databaseOrigin('existing', 'orders', [
    { access: 'database', database: 'orders', origin: 'managed' },
  ])).toBe('managed');
});

it('drops only the final managed database connection', () => {
  const target = { id: 'c1', access: 'database' as const, database: 'orders', origin: 'managed' as const };
  expect(deletionEffect(target, [])).toBe('role-and-database');
  expect(deletionEffect(target, [{ ...target, id: 'c2' }])).toBe('role-only');
});

it('rejects contradictory reserved labels instead of guessing', () => {
  let thrown: unknown;
  try {
    parseConnectionLabels({ 'postgres.access': 'full', 'postgres.database': 'orders' });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ status: 409 });
});
```

- [ ] **Step 6: Run label tests RED, implement, then run GREEN**

Run RED: `npm test -- src/domain/labels.test.ts`

Implement the exact reserved keys and these return types:

```ts
export type DatabaseOrigin = 'managed' | 'existing';
export type ConnectionAuthority =
  | { access: 'database'; database: string; origin: DatabaseOrigin }
  | { access: 'full' };
export type DeletionEffect = 'role-only' | 'role-and-database';
```

Run GREEN:

```bash
npm test -- src/domain/labels.test.ts
npm test
```

- [ ] **Step 7: Write failing deterministic-role and random-secret tests**

Create `credentials.test.ts`:

```ts
import { expect, it } from 'vitest';
import { databaseOwnerRole, generateAdminCredentials, generateLoginCredentials } from './credentials';

it('derives stable distinct safe roles from identity', async () => {
  const first = await generateLoginCredentials({
    callerId: 'manager-a', resourceId: 'resource-1', access: { scope: 'database', operation: 'create', database: 'orders' },
  });
  const again = await generateLoginCredentials({
    callerId: 'manager-a', resourceId: 'resource-1', access: { scope: 'database', operation: 'create', database: 'orders' },
  });
  expect(first.username).toBe(again.username);
  expect(first.username).toMatch(/^dc_user_[0-9a-f]{32}$/);
  expect(first.password).not.toBe(again.password);
  await expect(databaseOwnerRole('resource-1', 'orders')).resolves.toMatch(/^dc_db_[0-9a-f]{32}$/);
});

it('generates nonblank administrator credentials', () => {
  expect(generateAdminCredentials()).toEqual({
    username: expect.stringMatching(/^dc_admin_[0-9a-f]{32}$/),
    password: expect.stringMatching(/^.{32,}$/),
  });
});
```

- [ ] **Step 8: Run credentials RED, implement, and verify GREEN**

Use `crypto.getRandomValues` for passwords and `crypto.subtle.digest('SHA-256', ...)` over a length-delimited canonical identity. Never use `Math.random`. Exclude `operation` and caller labels from the login identity; include caller, resource, scope, database, and full-access superuser choice. Derive the database-owner role from resource ID and database name only.

Run:

```bash
npm test -- src/domain/credentials.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add postgres-interface/src/domain
git commit -m "feat: define postgres connection domain contract"
```

### Task 3: Resource and Connection Projections

**Files:**
- Create: `postgres-interface/src/platform/resources.ts`
- Create: `postgres-interface/src/platform/resources.test.ts`
- Create: `postgres-interface/src/platform/connections.ts`
- Create: `postgres-interface/src/platform/connections.test.ts`
- Create: `postgres-interface/src/test/fakes.ts`

**Interfaces:**
- Consumes: `RPCCaller`, `RPC.ResourceItem`, request/access and label types from Task 2
- Produces: `loadInstallationProjection(caller)`, `readInstallation(caller, resource)`, `listResourceConnections(caller, resourceId)`, `readPostgresConnection(caller, item)`, `findCompatibleConnection(...)`, and shared `deferred`/`fakeCaller` test helpers

Create these test-only helpers in `src/test/fakes.ts` before the first test:

```ts
import type { Events, RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import { vi } from 'vitest';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function fakeCaller(overrides: Record<string, unknown> = {}) {
  return {
    getMyResources: vi.fn(), getResource: vi.fn(), getConnections: vi.fn(),
    getConnection: vi.fn(), start: vi.fn(), getRun: vi.fn(), getRunUpdates: vi.fn(),
    ...overrides,
  } as unknown as RPCCaller;
}

export function testEventSource() {
  const listeners = new Set<(event: Events.InterfaceEvent) => void>();
  return {
    subscribe(listener: (event: Events.InterfaceEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(event: Events.InterfaceEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}
```

Keep resource/connection fixtures local to their test files so they state the contract each test
depends on.

- [ ] **Step 1: Write failing paginated resource-projection tests**

Test zero, one, multiple, malformed pages, and the Review Focus case with 51 resources:

```ts
it('loads every page before selecting the stable postgres resource', async () => {
  const caller = fakeCaller({
    getMyResources: vi.fn()
      .mockResolvedValueOnce({ items: fortyNineOthersAndOnePostgres, limit: 50, offset: 0, total: 51 })
      .mockResolvedValueOnce({ items: [lastOther], limit: 50, offset: 50, total: 51 }),
  });
  const projection = await loadInstallationProjection(caller);
  expect(projection).toEqual({ kind: 'installed', resource: postgresResource });
  expect(caller.getMyResources).toHaveBeenNthCalledWith(2, 'postgres', false, 50, 50);
});

it('reports a concrete conflict for two stable resources', async () => {
  await expect(loadInstallationProjection(callerWithResources([postgresA, postgresB])))
    .resolves.toEqual({ kind: 'conflict', resources: [postgresA, postgresB] });
});
```

- [ ] **Step 2: Run RED, implement resource loading, run GREEN**

Run RED: `npm test -- src/platform/resources.test.ts`

Implement:

```ts
export type InstallationProjection =
  | { kind: 'not-installed' }
  | { kind: 'installed'; resource: RPC.ResourceItem }
  | { kind: 'conflict'; resources: RPC.ResourceItem[] };

export type PostgresInstallation = {
  resource: RPC.ResourceItem;
  administrator: { username: string; password: string };
  platformConnection: { type: 'Platform'; data: { network: string } };
};
```

`loadInstallationProjection` validates pagination and filters only non-external type/name
`postgres`. `readInstallation` validates resource detail metadata and exact platform connection;
it throws `PostgresRequestError(400, 'PostgreSQL resource configuration is invalid')` without
changing the projection.

Run GREEN:

```bash
npm test -- src/platform/resources.test.ts
npm test
```

- [ ] **Step 3: Write failing paginated connection and detail-parser tests**

Cover 51 connections, manager ownership, valid database/full configs, malformed labels, malformed
platform connection, and compatibility conflicts:

```ts
it('loads every connection page before calculating database peers', async () => {
  const caller = fakeCaller({
    getConnections: vi.fn()
      .mockResolvedValueOnce({ items: firstFifty, limit: 50, offset: 0, total: 51 })
      .mockResolvedValueOnce({ items: [finalPeer], limit: 50, offset: 50, total: 51 }),
  });
  const items = await listResourceConnections(caller, 'resource-1');
  expect(items).toHaveLength(51);
});

it('rejects malformed authority labels and preserves the database', async () => {
  await expect(readPostgresConnection(caller, malformedItem))
    .rejects.toMatchObject({ status: 409 });
});
```

- [ ] **Step 4: Run RED, implement connection projection, run GREEN**

Define:

```ts
export type PostgresConnection = {
  item: RPC.ConnectionItem;
  managerId: string;
  resourceId: string;
  authority: ConnectionAuthority;
  access: AccessRequest;
  username: string;
  password: string;
  platformConnection: { type: 'Platform'; data: { network: string } };
  metadata: Record<string, unknown>;
};
```

Use `getConnections(50, offset, undefined, resourceId)` until the full page count is loaded, then
`getConnection(id)` for sensitive detail only when a workflow needs it. Validate the summary/detail
identity, labels, access discriminator, credentials, and platform connection. Never silently coerce
legacy or malformed data.

`findCompatibleConnection` compares trusted manager, resource, access identity, operation, and exact
caller-label compatibility. Return one of `none`, `match`, or `conflict`; multiple matches are a
conflict.

Run:

```bash
npm test -- src/platform/connections.test.ts
npm test
```

- [ ] **Step 5: Commit**

```bash
git add postgres-interface/src/platform/resources* postgres-interface/src/platform/connections* postgres-interface/src/test/fakes.ts
git commit -m "feat: project postgres state from resources and connections"
```

### Task 4: Runner Plans and Idempotent PostgreSQL Operations

**Files:**
- Create: `postgres-interface/src/platform/plans.ts`
- Create: `postgres-interface/src/platform/plans.test.ts`

**Interfaces:**
- Consumes: `PostgresInstallation`, `AccessRequest`, credentials, labels, exact resource and connection IDs
- Produces: `buildInstallPlan`, `buildProvisionPlan`, `buildDeletePlan`, `buildTeardownPlan`, and exported fixed script constants for plan-level tests

- [ ] **Step 1: Write failing install and teardown plan tests**

```ts
it('builds one stable postgres service, volume, and resource', () => {
  expect(buildInstallPlan({ username: 'dc_admin_' + 'a'.repeat(32), password: 'secret-value-that-is-long-enough' }))
    .toEqual({
      services: {
        postgres: {
          image: 'postgres:15',
          aliases: ['postgres'],
          environment: {
            POSTGRES_USER: 'dc_admin_' + 'a'.repeat(32),
            POSTGRES_PASSWORD: 'secret-value-that-is-long-enough',
            POSTGRES_DB: 'postgres',
          },
          resources: [{
            resource_type: 'postgres',
            name: 'postgres',
            metadata: {
              engine: 'postgres', version: '15',
              administrator: { username: 'dc_admin_' + 'a'.repeat(32), password: 'secret-value-that-is-long-enough' },
            },
          }],
          volumes: [{ name: 'postgres-data', mount_path: '/var/lib/postgresql/data' }],
        },
      },
      volumes: ['postgres-data'],
    });
});

it('uses the runner teardown action without guessed removals', () => {
  expect(buildTeardownPlan()).toEqual({});
});
```

- [ ] **Step 2: Run RED, implement install/teardown builders, run GREEN**

Run: `npm test -- src/platform/plans.test.ts`

Add narrow TypeScript plan types containing only fields documented by
`DEPLOY_COMMANDER_RUNNER_INTERFACE_GUIDE.md`. Do not model `object_hooks`.

- [ ] **Step 3: Add failing provisioning-plan tests**

Test every access variant and assert the complete connection create entry:

```ts
it('runs psql before creating the labeled connection record', () => {
  const plan = buildProvisionPlan({
    installation,
    callerId: 'consumer-1',
    access: { scope: 'database', operation: 'create', database: 'orders' },
    origin: 'managed',
    login: { username: 'dc_user_' + 'b'.repeat(32), password: 'connection-secret' },
    databaseOwner: 'dc_db_' + 'c'.repeat(32),
    callerLabels: { team: 'payments' },
  });
  expect(plan.services['postgres-admin']).toMatchObject({
    image: 'postgres:15', role: 'runner',
    connections: [installation.platformConnection],
  });
  expect(plan.connections?.create).toEqual([expect.objectContaining({
    name: 'postgres-connection', manager: 'consumer-1',
    resource: { id: 'resource-1' },
    labels: {
      team: 'payments', 'postgres.access': 'database',
      'postgres.database': 'orders', 'postgres.database-origin': 'managed',
    },
  })]);
  expect(JSON.stringify(plan)).not.toContain('object_hooks');
});
```

Assert connection metadata exactly preserves `host`, `port`, `database`, `username`, `password`,
`access`, and `platform_connection`.

- [ ] **Step 4: Implement exact idempotent provisioning scripts**

All scripts first wait for `pg_isready` with a bounded attempt count and use `psql -X
--set=ON_ERROR_STOP=1`. Pass values through environment variables and `\getenv`; never interpolate
user-controlled identifiers into shell or SQL source.

Database-create behavior must implement this sequence:

```sql
SELECT format('CREATE ROLE %I NOLOGIN', :'database_owner')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'database_owner')
\gexec
SELECT format('CREATE ROLE %I', :'target_username')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_username')
\gexec
SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'target_username', :'target_password'
)
\gexec
```

Then read the existing database owner. If the database is absent, create it with the deterministic
NOLOGIN database-owner role. If present with that owner, continue as an idempotent retry. If present
with any other owner, emit only `POSTGRES_MANAGER_ERROR: database-collision` and exit nonzero.
Revoke public privileges, grant database-local access to the login, and configure public-schema
access.

Existing-database behavior verifies a non-template, connectable database; absence emits only
`POSTGRES_MANAGER_ERROR: database-not-found`. It creates/alters the deterministic login and grants
database, schema, table, sequence, function, and relevant default privileges.

Constrained full access creates/alters a dedicated login with `CREATEDB`, `NOSUPERUSER`,
`NOCREATEROLE`, `NOREPLICATION`, and `NOBYPASSRLS`, then iterates non-template connectable databases
and applies broad database-local grants. Superuser access creates/alters a dedicated explicit
`SUPERUSER LOGIN`.

Run:

```bash
npm test -- src/platform/plans.test.ts
npm test
```

- [ ] **Step 5: Add failing cleanup-plan tests**

```ts
it('removes only the role when another managed connection remains', () => {
  const plan = buildDeletePlan({ installation, target, effect: 'role-only' });
  expect(plan.connections?.remove).toEqual([{
    name: 'postgres-connection', id: target.item.id, resource: { id: target.resourceId },
  }]);
  expect(plan.services['postgres-admin'].environment).not.toHaveProperty('DATABASE_OWNER');
});

it('drops a final managed database through its deterministic owner role', () => {
  const plan = buildDeletePlan({
    installation, target: managedTarget, effect: 'role-and-database',
    databaseOwner: 'dc_db_' + 'c'.repeat(32),
  });
  expect(plan.services['postgres-admin'].environment).toMatchObject({
    TARGET_DATABASE: 'orders', DATABASE_OWNER: 'dc_db_' + 'c'.repeat(32),
  });
  expect(plan.connections?.remove[0]).toEqual({
    name: 'postgres-connection', id: managedTarget.item.id,
    resource: { id: managedTarget.resourceId },
  });
});
```

- [ ] **Step 6: Implement idempotent cleanup scripts and verify GREEN**

Role-only cleanup iterates every connectable database, runs `REASSIGN OWNED` and `DROP OWNED` when
the role exists, then executes `DROP ROLE` only if it still exists.

Final-managed cleanup:

1. verifies that an existing target database is owned by the deterministic database-owner role;
2. fails safely without dropping anything when ownership differs;
3. disables new connections and terminates sessions;
4. drops the database when present;
5. drops the per-connection login idempotently;
6. drops the deterministic database-owner role idempotently;
7. lets the runner remove the exact connection only after the runner service exits successfully.

Run:

```bash
npm test -- src/platform/plans.test.ts
npm test
```

- [ ] **Step 7: Commit**

```bash
git add postgres-interface/src/platform/plans.ts postgres-interface/src/platform/plans.test.ts
git commit -m "feat: build idempotent postgres runner plans"
```

### Task 5: Exact Run Event Tracker

**Files:**
- Create: `postgres-interface/src/platform/runTracker.ts`
- Create: `postgres-interface/src/platform/runTracker.test.ts`

**Interfaces:**
- Consumes: `RPCCaller.start`, `getRun`, optional exact `getRunUpdates`, `Events.InterfaceEvent`, official status constants
- Produces: `RunEventSource`, `createRunTracker(caller, eventSource)`, `RunProgress`, `RunFailedError`, and `RunTracker.startAndWait(options, onProgress, signal)`

- [ ] **Step 1: Write failing event-ordering tests**

Use a controllable event source and deferred `start()` promise:

```ts
it('reports starting before start and binds a run-start event that arrives first', async () => {
  const progress: RunProgress[] = [];
  const started = deferred<{ id: string; queued_at: string; status: number }>();
  const caller = fakeCaller({ start: vi.fn(() => started.promise), getRun: vi.fn().mockResolvedValue(doneRun('run-1')) });
  const tracker = createRunTracker(caller, events);
  const waiting = tracker.startAndWait(startOptions('note-1'), (value) => progress.push(value), new AbortController().signal);
  expect(progress[0]).toEqual({ phase: 'starting', runId: null });
  events.publish(runStartEvent({ id: 'run-1', action: 'create-connection', note: 'note-1' }));
  started.resolve({ id: 'run-1', queued_at: '2026-09-20T00:00:00Z', status: STATUS_QUEUED });
  events.publish(runUpdateEvent({ id: 'run-1', status: STATUS_DONE }));
  await expect(waiting).resolves.toEqual(doneRun('run-1'));
});

it('ignores unrelated and duplicate events', async () => {
  const progress: RunProgress[] = [];
  const caller = fakeCaller({
    start: vi.fn().mockResolvedValue({ id: 'run-1', queued_at: '2026-09-20T00:00:00Z', status: STATUS_QUEUED }),
    getRun: vi.fn().mockResolvedValue(doneRun('run-1')),
  });
  const waiting = createRunTracker(caller, events).startAndWait(
    startOptions('note-1'), (value) => progress.push(value), new AbortController().signal,
  );
  events.publish(runUpdateEvent({ id: 'run-2', status: STATUS_RUNNING }));
  events.publish(runUpdateEvent({ id: 'run-1', status: STATUS_RUNNING, seq: 4 }));
  events.publish(runUpdateEvent({ id: 'run-1', status: STATUS_RUNNING, seq: 4 }));
  events.publish(runUpdateEvent({ id: 'run-1', status: STATUS_DONE, seq: 5 }));
  await waiting;
  expect(progress.filter((value) => value.phase === 'running')).toHaveLength(1);
  expect(progress.some((value) => value.runId === 'run-2')).toBe(false);
});

it('fails when run-start and start response IDs disagree', async () => {
  const started = deferred<{ id: string; queued_at: string; status: number }>();
  const caller = fakeCaller({ start: vi.fn(() => started.promise) });
  const waiting = createRunTracker(caller, events).startAndWait(
    startOptions('note-1'), vi.fn(), new AbortController().signal,
  );
  events.publish(runStartEvent({ id: 'run-from-event', action: 'create-connection', note: 'note-1' }));
  started.resolve({ id: 'run-from-response', queued_at: '2026-09-20T00:00:00Z', status: STATUS_QUEUED });
  await expect(waiting).rejects.toThrow('Run start identifiers did not match');
});

it('uses exact getRun for a known run when a terminal live event is missed', async () => {
  vi.useFakeTimers();
  const caller = fakeCaller({
    start: vi.fn().mockResolvedValue({ id: 'run-1', queued_at: '2026-09-20T00:00:00Z', status: STATUS_QUEUED }),
    getRun: vi.fn()
      .mockResolvedValueOnce(runningRun('run-1'))
      .mockResolvedValueOnce(doneRun('run-1')),
  });
  const waiting = createRunTracker(caller, events).startAndWait(
    startOptions('note-1'), vi.fn(), new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(waiting).resolves.toEqual(doneRun('run-1'));
  expect(caller.getRun).toHaveBeenCalledWith('run-1');
  vi.useRealTimers();
});

it('continues from a matching run-start when the start response is lost', async () => {
  const started = deferred<{ id: string; queued_at: string; status: number }>();
  const caller = fakeCaller({
    start: vi.fn(() => started.promise),
    getRun: vi.fn().mockResolvedValue(doneRun('run-1')),
  });
  const waiting = createRunTracker(caller, events).startAndWait(
    startOptions('note-1'), vi.fn(), new AbortController().signal,
  );
  events.publish(runStartEvent({ id: 'run-1', action: 'create-connection', note: 'note-1' }));
  started.reject(new Error('transport lost'));
  events.publish(runUpdateEvent({ id: 'run-1', status: STATUS_DONE, seq: 5 }));
  await expect(waiting).resolves.toEqual(doneRun('run-1'));
});

it('does not search history when start fails without a matching run-start', async () => {
  const caller = fakeCaller({ start: vi.fn().mockRejectedValue(new Error('offline')) });
  await expect(createRunTracker(caller, events).startAndWait(
    startOptions('note-1'), vi.fn(), new AbortController().signal,
  )).rejects.toThrow('Unable to start PostgreSQL operation');
  expect(caller.getRun).not.toHaveBeenCalled();
});

it('returns only a typed safe marker from a failed run log', async () => {
  const caller = fakeCaller({
    start: vi.fn().mockResolvedValue({ id: 'run-1', queued_at: '2026-09-20T00:00:00Z', status: STATUS_QUEUED }),
    getRun: vi.fn().mockResolvedValue(failedRun('run-1')),
  });
  const waiting = createRunTracker(caller, events).startAndWait(
    startOptions('note-1'), vi.fn(), new AbortController().signal,
  );
  events.publish(runLogEvent({
    id: 'run-1', seq: 3,
    message: 'POSTGRES_MANAGER_ERROR: database-collision password=must-not-escape',
  }));
  events.publish(runUpdateEvent({ id: 'run-1', status: STATUS_FAILED, seq: 4 }));
  await expect(waiting).rejects.toMatchObject({
    runId: 'run-1', marker: 'database-collision', message: 'PostgreSQL operation failed',
  });
});
```

- [ ] **Step 2: Run tracker tests RED**

Run: `npm test -- src/platform/runTracker.test.ts`

Expected: FAIL because the tracker does not exist.

- [ ] **Step 3: Implement the tracker with official constants**

Define:

```ts
export type RunProgress =
  | { phase: 'starting'; runId: null }
  | { phase: 'queued' | 'running' | 'done' | 'failed'; runId: string; message?: string };

export interface RunEventSource {
  subscribe(listener: (event: Events.InterfaceEvent) => void): () => void;
}

export class RunFailedError extends Error {
  constructor(
    readonly runId: string,
    readonly marker: 'database-not-found' | 'database-collision' | null,
  ) { super('PostgreSQL operation failed'); }
}

export interface RunTracker {
  startAndWait(
    options: StartRunOptions,
    onProgress: (progress: RunProgress) => void,
    signal: AbortSignal,
  ): Promise<RPC.GetRun>;
  dispose(): void;
}
```

Import `STATUS_QUEUED`, `STATUS_RUNNING`, `STATUS_DONE`, and `STATUS_FAILED`. Subscribe before
calling `start`. Buffer `run-start` by exact `(action,note)` and updates by run ID. Once bound, ignore
all other runs. On done, verify `getRun(runId)` is done before resolving. On failure, verify the exact
run and reject with `RunFailedError`. Observe `run-update` log payloads only for the two fixed,
credential-free markers `POSTGRES_MANAGER_ERROR: database-not-found` and
`POSTGRES_MANAGER_ERROR: database-collision`; catch up with `getRunUpdates` for that exact run ID
before finalizing a failure. Never expose raw logs through the error. Use a bounded exact-run poll
only for the known ID; never call `getRuns`, `getLatestRun`, or correlate against completed history.
Remove listeners, timers, and abort handlers on every exit.

- [ ] **Step 4: Run focused and full tests GREEN**

```bash
npm test -- src/platform/runTracker.test.ts
npm test
```

Expected: PASS with fake timers fully drained and no open-handle warning.

- [ ] **Step 5: Commit**

```bash
git add postgres-interface/src/platform/runTracker.ts postgres-interface/src/platform/runTracker.test.ts
git commit -m "feat: track exact postgres runs from events"
```

### Task 6: Approval-Gated Create Connection Workflow

**Files:**
- Create: `postgres-interface/src/workflows/createConnection.ts`
- Create: `postgres-interface/src/workflows/createConnection.test.ts`

**Interfaces:**
- Consumes: Task 2 request/label/credential functions, Task 3 projections, Task 4 provision plan, Task 5 `RunTracker`
- Produces: `createPostgresConnection(deps, request): Promise<RPC.CreateConnection>`, `CreateApprovalContext`, `CreateApprovalDecision`

- [ ] **Step 1: Write the failing approval-gate tests first**

```ts
it('does not generate credentials or start before approval', async () => {
  const approval = deferred<CreateApprovalDecision>();
  const deps = createDeps({ requestApproval: vi.fn(() => approval.promise) });
  const pending = createPostgresConnection(deps, validRequest);
  await waitFor(() => expect(deps.requestApproval).toHaveBeenCalledOnce());
  expect(deps.caller.start).not.toHaveBeenCalled();
  expect(deps.generateLoginCredentials).not.toHaveBeenCalled();
  expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
  approval.resolve({ allowed: false });
  await expect(pending).rejects.toMatchObject({ status: 499 });
});

it('requires approval before returning an exact existing connection', async () => {
  const approval = deferred<CreateApprovalDecision>();
  const deps = createDeps({ existing: exactConnection, requestApproval: () => approval.promise });
  let settled = false;
  const pending = createPostgresConnection(deps, validRequest);
  void pending.finally(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
  approval.resolve({ allowed: true, access: validRequest.metadata.requestedAccess! });
  await expect(pending).resolves.toEqual(exactConnectionResult);
});
```

Also add failing tests for no resource (`404`), resource conflict (`409`), labels-only user choice,
incompatible existing connection (`409`), managed-origin propagation, and success returning exact
`RPC.CreateConnection`. Add one test for each fixed runner marker: `database-not-found` becomes `404`,
`database-collision` becomes `409`, and an unmarked `RunFailedError` becomes sanitized `500`.

- [ ] **Step 2: Run create-workflow tests RED**

Run: `npm test -- src/workflows/createConnection.test.ts`

- [ ] **Step 3: Implement the minimal approval-first workflow**

Define:

```ts
export type CreateApprovalContext = {
  callingManagerId: string;
  requestedAccess: AccessRequest | null;
  callerLabels: Record<string, string>;
  databaseNames: string[];
};
export type CreateApprovalDecision =
  | { allowed: false }
  | { allowed: true; access: AccessRequest };
export type CreateConnectionRequest = {
  currentManagerId: string;
  callingManagerId: string;
  metadata: ParsedCreateRequest;
};
```

Order is mandatory:

1. validate current and calling manager IDs;
2. load installation summary and connection summaries needed to render the dialog;
3. await `requestApproval`;
4. reject with `499` if not allowed;
5. reload installation and connections;
6. calculate origin and exact compatibility;
7. return one exact match, conflict on ambiguity/incompatibility, or generate credentials;
8. compute deterministic database owner for database scope;
9. call `runTracker.startAndWait` with action `create-connection`, runner
   `ezenki/deploy-commander-runner:latest`, a credential-free note, resource target, and provision
   metadata;
10. reload, require exactly one matching connection, and return its full `RPC.CreateConnection`.

Catch `RunFailedError` at this boundary. Map only its typed marker to the documented `404` or `409`;
map every unmarked run failure to `PostgresRequestError(500, 'PostgreSQL connection creation
failed')`. Never inspect or return raw runner log text.

Do not close the wire in this domain workflow; Task 9 owns interface closure.

- [ ] **Step 4: Verify RED/GREEN and full suite**

```bash
npm test -- src/workflows/createConnection.test.ts
npm test
```

Expected: PASS, including assertions that no mutation occurs before approval.

- [ ] **Step 5: Commit**

```bash
git add postgres-interface/src/workflows/createConnection.ts postgres-interface/src/workflows/createConnection.test.ts
git commit -m "feat: gate postgres connection creation on approval"
```

### Task 7: Approval-Gated Delete Connection Workflow

**Files:**
- Create: `postgres-interface/src/workflows/deleteConnection.ts`
- Create: `postgres-interface/src/workflows/deleteConnection.test.ts`

**Interfaces:**
- Consumes: Task 2 deletion effect, Task 3 connection projections, Task 4 delete plan, Task 5 tracker
- Produces: `deletePostgresConnection(deps, request): Promise<{ connection: string }>`, `DeleteApprovalContext`, `DeleteApprovalDecision`

- [ ] **Step 1: Write failing no-side-effect and selection tests**

```ts
it('does not start cleanup or delete a record before confirmation', async () => {
  const approval = deferred<DeleteApprovalDecision>();
  const deps = deleteDeps({ requestApproval: () => approval.promise });
  const pending = deletePostgresConnection(deps, explicitDeleteRequest);
  await waitFor(() => expect(deps.requestApproval).toHaveBeenCalledOnce());
  expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
  expect(deps.caller.deleteConnection).not.toHaveBeenCalled();
  approval.resolve({ allowed: false });
  await expect(pending).rejects.toMatchObject({ status: 499 });
});

it('shows only connections owned by the trusted caller', async () => {
  const approval = deferred<DeleteApprovalDecision>();
  const deps = deleteDeps({
    connections: [callerConnection, otherManagerConnection],
    requestApproval: () => approval.promise,
  });
  const pending = deletePostgresConnection(deps, selectionDeleteRequest);
  await waitFor(() => expect(deps.requestApproval).toHaveBeenCalledOnce());
  expect(deps.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
    choices: [expect.objectContaining({ id: callerConnection.item.id })],
  }));
  approval.resolve({ allowed: false });
  await expect(pending).rejects.toMatchObject({ status: 499 });
});
```

- [ ] **Step 2: Add failing deletion-consequence and race tests**

Cover all four cleanup table rows, including the 51st peer from Task 3. Add the Review Focus race:

```ts
it('fails 409 before starting when a peer changes the approved cleanup consequence', async () => {
  const deps = deleteDeps({
    beforeApproval: [managedTarget, managedPeer],
    afterApproval: [managedTarget],
    decision: { allowed: true, connectionId: managedTarget.item.id },
  });
  await expect(deletePostgresConnection(deps, explicitDeleteRequest))
    .rejects.toMatchObject({ status: 409 });
  expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
});

it('rejects malformed labels and never drops the database', async () => {
  const deps = deleteDeps({ beforeApproval: [malformedTarget] });
  await expect(deletePostgresConnection(deps, explicitDeleteRequest))
    .rejects.toMatchObject({ status: 409 });
  expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run delete-workflow tests RED**

Run: `npm test -- src/workflows/deleteConnection.test.ts`

- [ ] **Step 4: Implement approval, refresh, fingerprint, and cleanup**

Define:

```ts
export type DeleteChoice = {
  id: string;
  access: AccessRequest;
  authority: ConnectionAuthority;
  effect: 'role-only' | 'role-and-database';
};
export type DeleteApprovalContext = {
  callingManagerId: string;
  requestedConnectionId: string | null;
  choices: DeleteChoice[];
};
export type DeleteApprovalDecision =
  | { allowed: false }
  | { allowed: true; connectionId: string };
export type DeleteConnectionRequest = {
  currentManagerId: string;
  callingManagerId: string;
  metadata: ParsedDeleteRequest;
};
```

Before approval, load all resource connections and filter candidates by trusted caller. After
approval, reload all connections, refetch the chosen detail, and compare a fingerprint containing
connection ID, manager, resource, authority labels, access discriminator, username, and platform
connection. Recompute `deletionEffect`; any target/effect change is `409`.

For final managed database cleanup, derive the database-owner role from resource and database. Start
one `delete-connection` run whose metadata combines the cleanup runner service and exact
connection-remove entry. After done, confirm `getConnection(id)` returns `404`; do not separately
call `deleteConnection`, because the runner plan owns removal. Return `{ connection: id }`.

- [ ] **Step 5: Run focused and full tests GREEN**

```bash
npm test -- src/workflows/deleteConnection.test.ts
npm test
```

- [ ] **Step 6: Commit**

```bash
git add postgres-interface/src/workflows/deleteConnection.ts postgres-interface/src/workflows/deleteConnection.test.ts
git commit -m "feat: gate postgres connection deletion on approval"
```

### Task 8: Installation and Teardown Workflows

**Files:**
- Create: `postgres-interface/src/workflows/lifecycle.ts`
- Create: `postgres-interface/src/workflows/lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 3 installation projection, Task 4 lifecycle plans, Task 5 tracker
- Produces: `installPostgres(deps)`, `teardownPostgres(deps)`, and lifecycle progress callbacks

- [ ] **Step 1: Write failing direct-install tests**

```ts
it('starts installation directly when the resource is absent', async () => {
  const deps = lifecycleDeps({ projection: { kind: 'not-installed' } });
  await installPostgres(deps);
  expect(deps.requestConfirmation).not.toHaveBeenCalled();
  expect(deps.runTracker.startAndWait).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'create', metadata: expectedInstallPlan }),
    deps.onProgress,
    deps.signal,
  );
});

it('does not use active or completed runs to decide installation', async () => {
  const deps = lifecycleDeps({ projection: { kind: 'installed', resource: postgresResource } });
  await expect(installPostgres(deps)).rejects.toMatchObject({ status: 409 });
  expect(deps.caller.getLatestRun).toBeUndefined();
});
```

- [ ] **Step 2: Write failing confirmed-teardown tests**

```ts
it('cancels teardown without starting a run', async () => {
  const deps = lifecycleDeps({
    projection: { kind: 'installed', resource: postgresResource },
    requestConfirmation: vi.fn().mockResolvedValue(false),
  });
  await teardownPostgres(deps);
  expect(deps.requestConfirmation).toHaveBeenCalledWith(expect.stringMatching(/all databases/i));
  expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
});

it('uses the supported teardown action and exact resource target after confirmation', async () => {
  const deps = lifecycleDeps({
    projection: { kind: 'installed', resource: postgresResource },
    requestConfirmation: vi.fn().mockResolvedValue(true),
  });
  await teardownPostgres(deps);
  expect(deps.runTracker.startAndWait).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'teardown', metadata: {},
      target: { kind: 'resource', id: postgresResource.id },
    }),
    deps.onProgress,
    deps.signal,
  );
  expect(deps.reloadProjection).toHaveBeenCalledOnce();
});
```

- [ ] **Step 3: Run lifecycle tests RED**

Run: `npm test -- src/workflows/lifecycle.test.ts`

- [ ] **Step 4: Implement lifecycle workflows**

`installPostgres` requires `not-installed`, generates administrator credentials, and starts action
`create` with no resource target because none exists yet. `teardownPostgres` requires one installed
resource, waits for `requestConfirmation`, then starts action `teardown` with that resource target.
Both use credential-free notes and reload projections after completion. A multiple-resource conflict
is `409`; a cancelled teardown returns without a run and is not recovery.

- [ ] **Step 5: Run focused and full tests GREEN**

```bash
npm test -- src/workflows/lifecycle.test.ts
npm test
```

- [ ] **Step 6: Commit**

```bash
git add postgres-interface/src/workflows/lifecycle.ts postgres-interface/src/workflows/lifecycle.test.ts
git commit -m "feat: add resource-driven postgres lifecycle actions"
```

### Task 9: Wire Integration and React Interface

**Files:**
- Create: `postgres-interface/src/platform/interfaceClient.ts`
- Create: `postgres-interface/src/platform/interfaceClient.test.ts`
- Create: `postgres-interface/src/components/ApprovalDialog.tsx`
- Create: `postgres-interface/src/components/CreateConnectionDialog.tsx`
- Create: `postgres-interface/src/components/DeleteConnectionDialog.tsx`
- Create: `postgres-interface/src/components/ProgressPanel.tsx`
- Create: `postgres-interface/src/components/Dashboard.tsx`
- Create: `postgres-interface/src/components/components.test.tsx`
- Create: `postgres-interface/src/app/App.tsx`
- Create: `postgres-interface/src/app/App.test.tsx`
- Modify: `postgres-interface/src/main.tsx`
- Modify: `postgres-interface/src/index.css`

**Interfaces:**
- Consumes: all workflows and domain contracts from Tasks 2-8
- Produces: `InterfaceClient`, one lifetime wire/caller/event source, `AppServices`, accessible approval UI, root dashboard, child close responses

Use these composition interfaces so React orchestration can be tested without mocking module
internals:

```ts
export interface InterfaceClient {
  wire: ReturnType<typeof createWire>;
  caller: RPCCaller;
  events: RunEventSource;
  dispose(): void;
}

export interface AppServices {
  createConnection: typeof createPostgresConnection;
  deleteConnection: typeof deletePostgresConnection;
  install: typeof installPostgres;
  teardown: typeof teardownPostgres;
}
```

- [ ] **Step 1: Write failing one-wire and cleanup tests**

```ts
it('creates one caller and forwards run events to one event source', () => {
  let handleEvent: ((event: Events.InterfaceEvent) => void) | undefined;
  const wire = fakeWire();
  vi.mocked(createWire).mockImplementation((_handleCall, onEvent) => {
    handleEvent = onEvent;
    return wire;
  });
  const client = createInterfaceClient();
  const received: Events.InterfaceEvent[] = [];
  client.events.subscribe((event) => received.push(event));
  handleEvent!(expectedRunUpdate);
  expect(received).toEqual([expectedRunUpdate]);
  client.dispose();
  expect(wire.end).toHaveBeenCalledOnce();
});
```

Implement `createWire` once, `RPC.SetupRPCCaller(wire)` once, a small subscriber set, and `dispose`
that ends the wire and tracker. The incoming call handler returns a structured unsupported-request
response; it does not throw.

- [ ] **Step 2: Write failing accessible dialog tests**

Test initial focus, Tab containment, Escape cancellation, focus return, proposal read-only fields,
labels-only editable access, delete consequence copy, and disabled Approve until required choices are
valid. The critical assertion is:

```ts
render(<CreateConnectionDialog context={context} onDecision={onDecision} />);
expect(screen.getByRole('dialog', { name: /approve postgresql connection/i })).toBeVisible();
expect(screen.queryByText(/preparing postgresql connection/i)).not.toBeInTheDocument();
await user.click(screen.getByRole('button', { name: /^approve$/i }));
expect(onDecision).toHaveBeenCalledWith({ allowed: true, access: expectedAccess });
```

- [ ] **Step 3: Implement shared modal and request dialogs**

Use semantic `role="dialog"`, `aria-modal="true"`, an accessible heading, Approve/Reject buttons,
focus trapping, Escape rejection, and focus restoration. Do not add remember-approval controls.
Create proposals are read-only when supplied by the caller. Delete dialogs show whether the action
removes only the role or also the final manager-created database.

- [ ] **Step 4: Write failing App routing and approval-order tests**

Cover root, create child, delete child, invalid child action, success close, failure close, and
component unmount. Define `childClient(metadata)` in the test file with `getManager`,
`getCallingManager`, and `getMetadata` mocks returning `postgres-manager`, `consumer-manager`, and
the supplied metadata; give it `vi.fn()` wire `close`/`end` methods and `testEventSource()`.
Define `appServices(overrides)` by filling all four `AppServices` methods with throwing `vi.fn()`
defaults and applying the supplied override. Define `rejectingAppServices(action)` so the selected
create/delete service awaits its `requestApproval`, throws `PostgresRequestError(499, ...)` when
rejected, and never invokes the run tracker. Include:

```ts
it('renders approval before create workflow progress and closes with RPC.CreateConnection', async () => {
  const completion = deferred<RPC.CreateConnection>();
  const client = childClient({ action: 'create-connection' });
  const services = appServices({
    createConnection: vi.fn(async (deps) => {
      const decision = await deps.requestApproval(createApprovalContext);
      if (!decision.allowed) throw new PostgresRequestError(499, 'PostgreSQL connection request was cancelled');
      deps.onProgress({ phase: 'starting', runId: null });
      return completion.promise;
    }),
  });
  render(<App client={client} services={services} />);
  expect(await screen.findByRole('dialog', { name: /approve postgresql connection/i })).toBeVisible();
  expect(screen.queryByText(/starting|queued|running/i)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /^approve$/i }));
  expect(await screen.findByText(/starting/i)).toBeVisible();
  completion.resolve(createdConnection);
  await waitFor(() => expect(client.wire.close).toHaveBeenCalledWith({
    manager: 'postgres-manager', ok: true, result: createdConnection,
  }));
});

it('closes rejected create and delete requests with 499 and zero starts', async () => {
  for (const action of ['create-connection', 'delete-connection'] as const) {
    const client = childClient({ action });
    const services = rejectingAppServices(action);
    const view = render(<App client={client} services={services} />);
    await user.click(await screen.findByRole('button', { name: /^reject$/i }));
    expect(client.caller.start).not.toHaveBeenCalled();
    expect(client.wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { message: expect.any(String), status: 499 },
    });
    view.unmount();
  }
});
```

- [ ] **Step 5: Implement startup and mode routing**

On startup retrieve `getManager()`, `getCallingManager()`, and `getMetadata()`. A null calling
manager renders the dashboard. A caller plus create/delete metadata renders the corresponding dialog
and only starts its workflow after the decision promise resolves. Convert `PostgresRequestError` to
`wire.close({ manager, ok:false, error:{ message,status } })`; sanitize unknown errors to status
`500` without exposing SQL, credentials, or raw runner metadata.

The root dashboard renders installation solely from `loadInstallationProjection`, lists current
connections, invokes direct install, and confirms teardown. Progress renders the `RunProgress`
provided by workflows. It never renders a Recovery view.

- [ ] **Step 6: Add startup composition in `main.tsx`**

```tsx
const client = createInterfaceClient();
const root = createRoot(document.getElementById('root')!);
root.render(<App client={client} />);
```

App cleanup disposes client resources exactly once on a real unmount. Do not wrap this lifetime
bridge in React Strict Mode, whose development-only effect replay would tear down the one wire while
the interface is still active.

- [ ] **Step 7: Run focused tests and full UI verification**

```bash
npm test -- src/platform/interfaceClient.test.ts src/components/components.test.tsx src/app/App.test.tsx
npm test
npm run lint
npm run build
```

Expected: PASS, no act warnings, no unhandled promise rejections, and no duplicate wire listeners.

- [ ] **Step 8: Commit**

```bash
git add postgres-interface/src
git commit -m "feat: add postgres manager react interface"
```

### Task 10: Public Guide Rewrite and Final Hardening

**Files:**
- Modify: `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md`
- Create: `postgres-interface/src/finalHardening.test.ts`
- Verify: all `postgres-interface/src/**/*.test.{ts,tsx}`

**Interfaces:**
- Consumes: implemented public behavior and approved specification
- Produces: one accurate consumer guide and repository-wide regression guards

- [ ] **Step 1: Write failing forbidden-architecture regression test**

Create a test that reads production `.ts`/`.tsx` files excluding tests and asserts no forbidden
symbols/copy:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : productionFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

function readProductionSource(): string {
  const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
  return productionFiles(sourceRoot).map((path) => readFileSync(path, 'utf8')).join('\n');
}

it('contains no manager database, latest-run, or recovery implementation', () => {
  const source = readProductionSource();
  expect(source).not.toMatch(/databaseQuery|getLatestRun|object_hooks/i);
  expect(source).not.toMatch(/recovery required|recovery state|PostgresRecovery/i);
});
```

Also assert every `caller.start` use is centralized in the event tracker and every connection
workflow test contains a pre-approval no-start assertion.

- [ ] **Step 2: Run the hardening test RED if forbidden generated/demo code remains**

Run: `npm test -- src/finalHardening.test.ts`

Expected: FAIL for any forbidden production symbol; if it passes immediately, confirm the test by
temporarily adding a forbidden fixture string, observe failure, then remove the fixture before
continuing.

- [ ] **Step 3: Rewrite the PostgreSQL integration guide**

Retain the exact published request examples and `RPC.CreateConnection`/delete success shapes. Make
these rules unambiguous:

- an existing PostgreSQL resource is required;
- create and delete always require explicit approval, including exact reuse;
- the three reserved labels are `postgres.access`, `postgres.database`, and
  `postgres.database-origin`;
- only the final connection to a `managed` database drops it;
- install is a root dashboard action, not a connection-request side effect;
- run events show transient progress, while resources/connections are durable authority;
- retries rely on idempotent PostgreSQL operations and current resources/connections;
- failure statuses are `400`, `404`, `409`, `499`, and `500` as defined in the spec.

Delete every statement instructing consumers to handle recovery, `503`, catalog state,
`databaseQuery`, completed-run reconciliation, or cleanup history.

- [ ] **Step 4: Add contract tests for guide examples**

Parse the guide's JSON request examples or represent each exact example in
`requests.test.ts`; assert all documented valid examples parse and all reserved-label override
examples fail `400`. Assert returned fixtures satisfy the documented connection metadata and delete
result shapes.

```ts
it.each([
  { action: 'create-connection', labels: { team: 'payments' } },
  { action: 'create-connection', scope: 'database', operation: 'create', database: 'orders' },
  { action: 'create-connection', scope: 'database', operation: 'existing', database: 'warehouse' },
  { action: 'create-connection', scope: 'full', superuser: false },
  { action: 'create-connection', scope: 'full', superuser: true },
])('parses documented create request %#', (metadata) => {
  expect(parseCreateRequest(metadata).action).toBe('create-connection');
});

it.each(['postgres.access', 'postgres.database', 'postgres.database-origin'])(
  'rejects caller override of reserved label %s',
  (key) => {
    let thrown: unknown;
    try {
      parseCreateRequest({ action: 'create-connection', labels: { [key]: 'override' } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ status: 400 });
  },
);

it('keeps the documented delete success shape minimal', () => {
  expect({ connection: 'connection-1' }).toEqual({ connection: expect.any(String) });
});
```

- [ ] **Step 5: Run complete verification**

From `postgres-interface`:

```bash
npm test
npm run lint
npm run build
npm run format:check
```

From the repository root:

```bash
git diff --check
rg -n "databaseQuery|getLatestRun|object_hooks|recovery required|PostgresRecovery" postgres-interface/src \
  -g '!*.test.ts' -g '!*.test.tsx'
```

Expected: all npm commands pass; `git diff --check` prints nothing; `rg` returns exit code `1` with
no matches.

- [ ] **Step 6: Inspect final state authority manually**

Confirm by code path:

```text
dashboard installation -> getMyResources/getResource only
connection list/access -> getConnections/getConnection only
create/delete progress -> run-start/run-update + exact getRun only
database deletion -> target/peer connection labels only
```

Confirm no source module imports or references an old deleted implementation.

- [ ] **Step 7: Commit documentation and hardening**

```bash
git add docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md postgres-interface/src/finalHardening.test.ts postgres-interface/src/domain/requests.test.ts
git commit -m "docs: publish resource-driven postgres interface contract"
```

- [ ] **Step 8: Invoke completion verification and branch finishing skills**

Before claiming completion, use `superpowers:verification-before-completion` and rerun the exact
commands above. Then use `superpowers:requesting-code-review`. Address valid findings with TDD and
repeat full verification. Finally use `superpowers:finishing-a-development-branch` to confirm the
work is integrated into the intended local branch; if a worktree was used, explicitly verify the
commits are present on the user's target branch before reporting completion.
