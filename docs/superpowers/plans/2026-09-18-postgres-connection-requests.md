# PostgreSQL Connection Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mandatory-approved PostgreSQL database and full-access requests, runner-native connection labels and catalog hooks, multiple connections per consumer, updated documentation, and deterministic Prettier formatting.

**Architecture:** Parse child-interface metadata into a small approved-access domain model, let the user approve a complete immutable request or configure an omitted request, and execute the approved operation as one standard-runner plan. A regular PostgreSQL runner-role service performs fixed SQL, the runner creates the Deploy Commander connection with initial labels, and a connection object hook updates the credential-free database catalog.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Vitest 4, Testing Library, `@ezenki/deploy-commander-installer-interface` 0.5.0, PostgreSQL 15 client image, SurrealQL manager-database hooks, Prettier 3.9.8, ESLint 9.

**Spec:** `docs/superpowers/specs/2026-09-18-postgres-connection-requests-design.md`

## Global Constraints

- Continue using `ezenki/deploy-commander-runner:latest`; do not add or modify a runner image.
- Continue using the regular `postgres:15` image for PostgreSQL service and runner-role operations.
- Treat the corrected runner and manager guides as authoritative; emit only documented metadata fields.
- The child request metadata is flat: `action`, optional `labels`, and either no access fields or one complete database/full-access variant.
- Require user approval for every request, including exact duplicates; remove remembered approval completely.
- Never accept caller manager/resource IDs, credentials, SQL, host, port, or platform connection data.
- Reserve `postgres.access` and `postgres.database`; reject caller conflicts.
- Never interpolate untrusted values into SQL; use `psql` variables plus PostgreSQL identifier/literal formatting.
- Never place credentials in labels, catalog rows, notes, logs, errors, URLs, or browser storage.
- The manager database supplements Deploy Commander connections and must not become the credential or authorization authority.
- New database collisions fail without changing ownership; existing-database and full-access cleanup never drops a database.
- Every code change follows red-green-refactor and every task ends with its focused tests passing.

---

### Task 1: Formatting Toolchain and Flat Request Contract

**Files:**
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Modify: `postgres-interface/package.json:6-40`
- Create: `postgres-interface/src/lib/postgresConnectionRequest.ts`
- Create: `postgres-interface/src/lib/postgresConnectionRequest.test.ts`
- Modify: `postgres-interface/src/lib/postgresErrors.ts:1-20`

**Interfaces:**
- Consumes: raw `unknown` returned by `RPCCaller.getMetadata()`.
- Produces: `AccessRequest`, `DatabaseAccess`, `FullAccess`, `ParsedConnectionRequest`, `parseConnectionRequest(value)`, `generateDatabaseName(random?)`, `connectionLabels(access, callerLabels)`, `sameLabels(left, right)`, and status-bearing `PostgresRequestError`.

- [ ] **Step 1: Add failing parser and label tests**

Create `postgresConnectionRequest.test.ts` with concrete cases:

```ts
import { describe, expect, it } from 'vitest';
import {
  connectionLabels,
  generateDatabaseName,
  parseConnectionRequest,
  sameLabels,
} from './postgresConnectionRequest';

describe('parseConnectionRequest', () => {
  it('accepts labels-only metadata for user configuration', () => {
    expect(parseConnectionRequest({
      action: 'create-connection',
      labels: { team: 'payments' },
    })).toEqual({ labels: { team: 'payments' }, access: null });
  });

  it.each([
    {
      action: 'create-connection',
      scope: 'database',
      operation: 'create',
      database: 'orders',
    },
    {
      action: 'create-connection',
      scope: 'database',
      operation: 'existing',
      database: 'warehouse',
    },
    {
      action: 'create-connection',
      scope: 'full',
      superuser: false,
    },
    {
      action: 'create-connection',
      scope: 'full',
      superuser: true,
    },
  ])('accepts complete access metadata %#', (metadata) => {
    expect(parseConnectionRequest(metadata).access).not.toBeNull();
  });

  it.each([
    { action: 'create-connection', scope: 'database', operation: 'create' },
    { action: 'create-connection', scope: 'full' },
    { action: 'create-connection', unknown: true },
    { action: 'create-connection', labels: { 'postgres.access': 'database' } },
    { action: 'create-connection', labels: { ' postgres.database ': 'orders' } },
    { action: 'create-connection', scope: 'database', operation: 'existing', database: 'template0' },
  ])('rejects malformed or conflicting metadata %#', (metadata) => {
    expect(() => parseConnectionRequest(metadata)).toThrow('Invalid PostgreSQL connection request');
  });
});

describe('connection request helpers', () => {
  it('generates the stable UUID-shaped database form', () => {
    expect(generateDatabaseName((length) => new Uint8Array(length).fill(10)))
      .toBe('db_0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a');
  });

  it('merges caller and reserved labels', () => {
    expect(connectionLabels(
      { scope: 'database', operation: 'create', database: 'orders' },
      { team: 'payments' },
    )).toEqual({
      team: 'payments',
      'postgres.access': 'database',
      'postgres.database': 'orders',
    });
  });

  it('compares complete label maps independent of key order', () => {
    expect(sameLabels({ a: '1', b: '' }, { b: '', a: '1' })).toBe(true);
    expect(sameLabels({ a: '1' }, { a: '2' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the request tests and confirm the missing module failure**

Run: `cd postgres-interface && npm test -- src/lib/postgresConnectionRequest.test.ts`

Expected: FAIL because `./postgresConnectionRequest` does not exist.

- [ ] **Step 3: Implement the exact request domain and public errors**

Use these public shapes in `postgresConnectionRequest.ts`:

```ts
export type DatabaseAccess = {
  scope: 'database';
  operation: 'create' | 'existing';
  database: string;
};

export type FullAccess = {
  scope: 'full';
  superuser: boolean;
};

export type AccessRequest = DatabaseAccess | FullAccess;

export interface ParsedConnectionRequest {
  access: AccessRequest | null;
  labels: Record<string, string>;
}

export const RESERVED_CONNECTION_LABELS = new Set([
  'postgres.access',
  'postgres.database',
]);
```

Implement strict own-key validation for the three approved variants. Normalize database names only by validating their original string; do not silently trim or change an approved name. Use `new TextEncoder().encode(name).length <= 63`, reject empty/NUL/template names, trim label keys, reject duplicate normalized keys, preserve label values exactly, and reject both reserved keys.

Add to `postgresErrors.ts`:

```ts
export class PostgresRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 499,
    message: string,
  ) {
    super(message);
    this.name = 'PostgresRequestError';
  }
}
```

- [ ] **Step 4: Add Prettier and dependency upgrades**

Set the interface dependency to `^0.5.0`, add `prettier: "^3.9.8"`, and add these scripts:

```json
{
  "format": "prettier --config ../.prettierrc.json --ignore-path ../.prettierignore --write . ../docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md",
  "format:check": "prettier --config ../.prettierrc.json --ignore-path ../.prettierignore --check . ../docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md"
}
```

Use this root configuration:

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

Use this root ignore file:

```text
**/node_modules
**/dist
**/coverage
docs/integrations/DEPLOY_COMMANDER_RUNNER_INTERFACE_GUIDE.md
docs/integrations/MANAGER_INTERFACE_GUIDE.md
```

Run `cd postgres-interface && npm install` to refresh installed types and dependency metadata.

- [ ] **Step 5: Run focused tests and format the new files**

Run:

```bash
cd postgres-interface
npx prettier --config ../.prettierrc.json --write src/lib/postgresConnectionRequest.ts src/lib/postgresConnectionRequest.test.ts src/lib/postgresErrors.ts package.json
npm test -- src/lib/postgresConnectionRequest.test.ts
npm run build
```

Expected: request tests PASS and TypeScript/Vite build PASS.

- [ ] **Step 6: Commit the request boundary**

```bash
git add .prettierrc.json .prettierignore postgres-interface/package.json postgres-interface/src/lib/postgresConnectionRequest.ts postgres-interface/src/lib/postgresConnectionRequest.test.ts postgres-interface/src/lib/postgresErrors.ts
git commit -m "feat: validate postgres connection requests"
```

### Task 2: Mode-Specific PostgreSQL Access and Cleanup Plans

**Files:**
- Modify: `postgres-interface/src/lib/credentials.ts:1-46`
- Modify: `postgres-interface/src/lib/credentials.test.ts:1-70`
- Create: `postgres-interface/src/lib/postgresAccessPlans.ts`
- Create: `postgres-interface/src/lib/postgresAccessPlans.test.ts`
- Modify: `postgres-interface/src/lib/postgresIntegration.test.ts:1-92`

**Interfaces:**
- Consumes: `AccessRequest`, administrator credentials, generated login credentials, and authoritative `PlatformConnection`.
- Produces: `LoginCredentials`, `generateLoginCredentials(random?)`, `buildAccessService(access, administrator, login, platform)`, and `buildCleanupService(access, administrator, login, platform)`.

- [ ] **Step 1: Write failing credentials and plan tests**

Add credential assertions:

```ts
const login = generateLoginCredentials(sequenceRandomBytes().random);
expect(login.username).toMatch(/^dc_user_[0-9a-f]{32}$/);
expect(login.password).toMatch(/^[A-Za-z0-9_-]+$/);
expect(login).not.toHaveProperty('database');
```

Create `postgresAccessPlans.test.ts` with one exact service-plan assertion per mode:

```ts
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
```

Also assert:

- New-database SQL contains a positive collision failure and no unconditional `ALTER DATABASE ... OWNER`.
- Existing-database SQL verifies existence and never contains `DROP DATABASE` or `ALTER DATABASE ... OWNER`.
- Constrained full SQL contains `CREATEDB` and explicit `NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS`.
- Superuser SQL creates a dedicated `SUPERUSER` login.
- Cleanup for `operation: 'create'` drops the target database then role.
- Cleanup for existing/full modes drops only the role.
- Scripts contain no concrete passwords and do not enable shell tracing.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `cd postgres-interface && npm test -- src/lib/credentials.test.ts src/lib/postgresAccessPlans.test.ts`

Expected: FAIL because the new credential and plan interfaces do not exist.

- [ ] **Step 3: Split database naming from login credential generation**

Replace `LogicalCredentials` with:

```ts
export interface LoginCredentials {
  username: string;
  password: string;
}

export function generateLoginCredentials(
  random: RandomBytes = browserRandomBytes,
): LoginCredentials {
  return {
    username: `dc_user_${toHex(getBytes(random, 16))}`,
    password: toBase64Url(getBytes(random, 32)),
  };
}
```

Database names come from the approved `AccessRequest`, never from the login generator.

- [ ] **Step 4: Implement fixed SQL programs for all modes**

In `postgresAccessPlans.ts`, keep shared readiness and administrator environment logic private. Each program must start with the bounded `pg_isready` loop and `psql -X --quiet --set=ON_ERROR_STOP=1`.

For new databases, use a collision gate before creation:

```sql
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_database')
  THEN 1 / 0
  ELSE 1
END;
SELECT format('CREATE ROLE %I', :'target_username') \gexec
SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'target_username', :'target_password'
) \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'target_database', :'target_username') \gexec
```

For existing databases, fail unless the target exists and is not a template, create the non-owner login, grant `CONNECT`, `TEMPORARY`, and `CREATE` on the database, then connect to it and grant broad privileges across non-system schemas and current tables, sequences, and routines. Generate every identifier-bearing statement with `format(... %I ...)` and `\gexec`. Apply default privileges for each current object owner that the administrator can alter.

For constrained full access, create the dedicated `CREATEDB` login with all prohibited attributes explicit, enumerate current connectable non-template databases from `pg_database`, and apply the existing-database grant program to each. For superuser access, create a dedicated login with `SUPERUSER LOGIN PASSWORD` and no reuse of the installation administrator credential.

Implement two cleanup programs: created-database cleanup terminates target sessions, drops that database, and drops the role; role-only cleanup reassigns/drops grants owned by the role where needed and drops only the role.

- [ ] **Step 5: Make the integration harness exercise each SQL mode**

Refactor `postgresIntegration.test.ts` to derive Docker environment from the selected access mode and add tests with unique generated names for:

```ts
expect(await query(`SELECT datdba::regrole::text FROM pg_database WHERE datname = '${database}'`))
  .toBe(login.username);
expect(await query(`SELECT rolsuper FROM pg_roles WHERE rolname = '${constrained.username}'`))
  .toBe('f');
expect(await query(`SELECT rolcreatedb FROM pg_roles WHERE rolname = '${constrained.username}'`))
  .toBe('t');
expect(await query(`SELECT rolsuper FROM pg_roles WHERE rolname = '${superuser.username}'`))
  .toBe('t');
```

Create a pre-existing database owned by the integration administrator, grant access, assert its owner is unchanged, run role-only cleanup, and assert the database remains. Create a collision database and assert the new-database plan fails while its owner remains unchanged.

- [ ] **Step 6: Run unit tests; run Docker integration when configured**

Run:

```bash
cd postgres-interface
npm test -- src/lib/credentials.test.ts src/lib/postgresAccessPlans.test.ts
POSTGRES_INTEGRATION_CONTAINER="$POSTGRES_INTEGRATION_CONTAINER" npm test -- src/lib/postgresIntegration.test.ts
```

Expected: unit tests PASS. Integration tests PASS when the environment variable names a prepared PostgreSQL container; otherwise Vitest reports the suite skipped.

- [ ] **Step 7: Commit mode-specific access plans**

```bash
git add postgres-interface/src/lib/credentials.ts postgres-interface/src/lib/credentials.test.ts postgres-interface/src/lib/postgresAccessPlans.ts postgres-interface/src/lib/postgresAccessPlans.test.ts postgres-interface/src/lib/postgresIntegration.test.ts
git commit -m "feat: add postgres access modes"
```

### Task 3: Runner Connection Plan and Manager-Database Catalog

**Files:**
- Modify: `postgres-interface/src/lib/postgresContracts.ts:1-72`
- Modify: `postgres-interface/src/lib/postgresContracts.test.ts:1-60`
- Create: `postgres-interface/src/lib/postgresCatalog.ts`
- Create: `postgres-interface/src/lib/postgresCatalog.test.ts`
- Modify: `postgres-interface/src/lib/postgresPlans.ts:1-193`
- Modify: `postgres-interface/src/lib/postgresPlans.test.ts:1-167`

**Interfaces:**
- Consumes: Task 1 access/label types and Task 2 service-plan builders.
- Produces: documented runner transport types, `buildCatalogHook(access, resourceId)`, `listCatalogDatabases(caller, resourceId)`, `buildConnectionRunPlan(input)`, `buildCleanupPlan(input)`, and access-aware `buildConnectionMetadata(...)`.

- [ ] **Step 1: Add failing runner-plan and catalog tests**

Assert a database access plan contains the documented runner contract:

```ts
expect(buildConnectionRunPlan(input)).toMatchObject({
  services: { 'postgres-admin': { role: 'runner' } },
  connections: {
    create: [{
      name: 'postgres-connection',
      manager: 'consumer-manager',
      resource: { id: 'resource-1' },
      labels: {
        team: 'payments',
        'postgres.access': 'database',
        'postgres.database': 'orders',
      },
    }],
  },
  object_hooks: [{
    kind: 'connection',
    name: 'postgres-connection',
    create: { before: expect.objectContaining({ bindings: expect.any(Object) }) },
  }],
});
```

Assert a full-access plan has `postgres.access=full`, no `postgres.database`, and no database catalog hook. Assert cleanup of a newly created database contains a `container` hook that deletes its catalog record, while existing/full cleanup has no catalog delete hook.

In `postgresCatalog.test.ts`, assert the upsert query uses fixed text, deterministic record IDs, bound values, `IF NOT EXISTS`, a unique resource/name identity, and an origin-preserving expression. Assert list parsing rejects statement errors, malformed rows, duplicate names, and records for another resource.

- [ ] **Step 2: Run the focused tests and confirm contract failures**

Run: `cd postgres-interface && npm test -- src/lib/postgresCatalog.test.ts src/lib/postgresPlans.test.ts src/lib/postgresContracts.test.ts`

Expected: FAIL because runner connection, hook, and catalog types are absent.

- [ ] **Step 3: Extend only the documented runner transport types**

Add these structures to `postgresContracts.ts`:

```ts
export interface RunnerConnectionCreate {
  name?: string;
  manager: string;
  resource: { id: string };
  metadata: PostgresConnectionMetadata;
  labels?: Record<string, string>;
}

export interface DatabaseQuery {
  query: string;
  bindings?: Record<string, unknown>;
}

export interface ObjectHooks {
  kind: 'container' | 'volume' | 'network' | 'resource' | 'connection';
  name: string;
  create?: { before?: DatabaseQuery; after?: DatabaseQuery };
  remove?: { before?: DatabaseQuery; after?: DatabaseQuery };
}

export interface RunnerMetadata {
  services?: Record<string, RunnerService>;
  connections?: { create?: RunnerConnectionCreate[] };
  object_hooks?: ObjectHooks[];
  remove_services?: string[];
  volumes?: string[];
  remove_volumes?: string[];
}
```

Extend `PostgresConnectionMetadata` with:

```ts
access:
  | { scope: 'database'; operation: 'create' | 'existing' }
  | { scope: 'full'; superuser: boolean };
```

- [ ] **Step 4: Implement catalog query builders and strict list parsing**

Use a deterministic base64url record key derived from `resourceId + NUL + database`. Bind all values. The fixed upsert query must:

```text
BEGIN TRANSACTION;
DEFINE TABLE/FIELD/INDEX IF NOT EXISTS;
UPSERT type::thing('postgres_database', $record_id);
preserve origin='managed' if already present;
set resource_id, name, origin, and updated_at;
COMMIT;
```

The delete query targets only the deterministic record ID for the newly removed managed database. `listCatalogDatabases` calls:

```ts
caller.databaseQuery(
  'SELECT name FROM postgres_database WHERE resource_id = $resource_id ORDER BY name',
  { resource_id: resourceId },
);
```

Require every returned statement status to equal `OK`; accept only unique valid database names.

- [ ] **Step 5: Assemble the full runner plan**

Replace the old service-only `buildProvisionPlan` with:

```ts
export interface ConnectionRunPlanInput {
  administrator: AdminCredentials;
  login: LoginCredentials;
  access: AccessRequest;
  callerId: string;
  resourceId: string;
  platform: PlatformConnection;
  callerLabels: Record<string, string>;
}

export function buildConnectionRunPlan(input: ConnectionRunPlanInput): RunnerMetadata;
```

Merge the Task 2 access service, a single named connection create, initial labels from `connectionLabels`, and the database `create.before` catalog hook. Build metadata with `database: access.scope === 'database' ? access.database : 'postgres'` and the access discriminator. Never include administrator credentials in connection metadata.

Make `buildCleanupPlan` accept the original access and add the catalog-delete container hook only for manager-created databases.

- [ ] **Step 6: Run focused tests and the TypeScript build**

Run:

```bash
cd postgres-interface
npm test -- src/lib/postgresCatalog.test.ts src/lib/postgresPlans.test.ts src/lib/postgresContracts.test.ts
npm run build
```

Expected: focused tests PASS and build PASS.

- [ ] **Step 7: Commit runner-native connection plans**

```bash
git add postgres-interface/src/lib/postgresContracts.ts postgres-interface/src/lib/postgresContracts.test.ts postgres-interface/src/lib/postgresCatalog.ts postgres-interface/src/lib/postgresCatalog.test.ts postgres-interface/src/lib/postgresPlans.ts postgres-interface/src/lib/postgresPlans.test.ts
git commit -m "feat: build runner-native postgres connections"
```

### Task 4: Exact Multi-Connection Lookup and Label Reconciliation

**Files:**
- Modify: `postgres-interface/src/lib/postgresConnectionContract.ts:1-199`
- Modify: `postgres-interface/src/lib/postgresConnectionContract.test.ts:1-199`

**Interfaces:**
- Consumes: `RPCCaller` 0.5.0 label-aware overloads, `AccessRequest`, expected labels, and authoritative platform connection.
- Produces: `ConnectionIdentity`, `ConnectionLookupResult`, `normalizePostgresConnection(...)`, and `findExistingConnection(...)` that select one exact identity without rejecting unrelated connections.

- [ ] **Step 1: Replace the one-connection tests with exact-identity tests**

Add two summaries with different reserved labels and full configurations. Assert the lookup calls:

```ts
expect(caller.getConnections).toHaveBeenCalledWith({
  manager: 'consumer-manager',
  resource: 'resource-1',
  labels: {
    'postgres.access': 'database',
    'postgres.database': 'orders',
  },
  label_match: 'all',
  include_labels: true,
  limit: 50,
  offset: 0,
});
```

Then assert it fetches candidate details with:

```ts
caller.getConnection(candidate.id, { include_labels: true });
```

Cover exact match among unrelated connections, no match, two exact matches (recovery error), same identity with conflicting caller labels (`kind: 'conflict'`), full constrained versus full superuser, arbitrary valid database names, and authoritative platform enrichment.

- [ ] **Step 2: Run focused tests and confirm old cardinality fails**

Run: `cd postgres-interface && npm test -- src/lib/postgresConnectionContract.test.ts`

Expected: FAIL because the current function rejects any total greater than one and does not request labels.

- [ ] **Step 3: Implement exact identity and label-aware pagination**

Use:

```ts
export interface ConnectionIdentity {
  managerId: string;
  resourceId: string;
  access: AccessRequest;
  labels: Record<string, string>;
  connectionId?: string;
}

export type ConnectionLookupResult =
  | { kind: 'none' }
  | { kind: 'match'; connection: RPC.CreateConnection }
  | { kind: 'conflict'; connectionId: string };
```

Use server-side reserved-label filtering, but validate every page, summary owner/resource/external flag, included label map, full configuration, access discriminator, database/default database, generated username, nonblank password, and current platform. Unrelated candidates are allowed. More than one exact candidate is contradictory recovery state.

- [ ] **Step 4: Run focused tests and all contract tests**

Run:

```bash
cd postgres-interface
npm test -- src/lib/postgresConnectionContract.test.ts src/lib/postgresContracts.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit multi-connection discovery**

```bash
git add postgres-interface/src/lib/postgresConnectionContract.ts postgres-interface/src/lib/postgresConnectionContract.test.ts
git commit -m "feat: resolve exact postgres connections"
```

### Task 5: Versioned Run Recovery for Access Modes

**Files:**
- Modify: `postgres-interface/src/lib/connectionRuns.ts:1-77`
- Modify: `postgres-interface/src/lib/connectionRuns.test.ts:1-29`
- Modify: `postgres-interface/src/lib/postgresRuns.ts:1-100`
- Modify: `postgres-interface/src/lib/postgresRuns.test.ts:1-80`

**Interfaces:**
- Consumes: the Task 3 runner plan persisted in `RPC.GetRun.config.metadata`.
- Produces: v2 provision/cleanup notes and `ProvisionRunRecord`/`CleanupRunRecord` containing access, labels, login credentials, caller/resource identity, run ID, and status.

- [ ] **Step 1: Add failing v2 recovery tests**

Build realistic `RPC.GetRun` fixtures for each access mode. Assert:

```ts
expect(parseProvisionRun(databaseRun)).toEqual({
  identity,
  runId: 'provision-run',
  status: 2,
  access: { scope: 'database', operation: 'existing', database: 'orders' },
  login: { username, password: 'logical-password' },
  labels: {
    team: 'payments',
    'postgres.access': 'database',
    'postgres.database': 'orders',
  },
});
```

Reject note/config caller or resource mismatch, wrong connection hook name, absent connection create, malformed access metadata, reserved-label mismatch, full-access metadata with a database label, role-only cleanup that contains a database-drop script, and created-database cleanup without the catalog-delete hook.

- [ ] **Step 2: Run recovery tests and verify old parsing fails**

Run: `cd postgres-interface && npm test -- src/lib/connectionRuns.test.ts src/lib/postgresRuns.test.ts`

Expected: FAIL because the current parser assumes only generated database access and service-only plans.

- [ ] **Step 3: Implement v2 notes and structural run validation**

Emit ``postgres-provision:v2:${encodeURIComponent(callerId)}:${encodeURIComponent(resourceId)}:${operationId}`` and the equivalent `postgres-cleanup:v2` note. Parse legacy v1 records only as the old generated-database/create mode so a run started before deployment can be recovered safely; all new writes use v2.

Validate the persisted service environment and the named `connections.create` entry together. Reconstruct access from validated connection metadata, not from note text. Recompute reserved labels and compare all included labels. Return generated login credentials only after the complete boundary validates.

Update `validAction`/latest-run recognition only if new action strings are introduced; retain `create-connection` and `cleanup-connection` when possible to preserve lifecycle locking.

- [ ] **Step 4: Run recovery and lifecycle tests**

Run:

```bash
cd postgres-interface
npm test -- src/lib/connectionRuns.test.ts src/lib/postgresRuns.test.ts src/lib/lifecycleActions.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit access-aware recovery**

```bash
git add postgres-interface/src/lib/connectionRuns.ts postgres-interface/src/lib/connectionRuns.test.ts postgres-interface/src/lib/postgresRuns.ts postgres-interface/src/lib/postgresRuns.test.ts
git commit -m "feat: recover postgres access runs"
```

### Task 6: Runner-Native Connection Workflow

**Files:**
- Modify: `postgres-interface/src/lib/createPostgresConnection.ts:1-159`
- Create: `postgres-interface/src/lib/createPostgresConnection.test.ts`

**Interfaces:**
- Consumes: parsed metadata, approval callback, catalog list reader, Task 3 plan builders, Task 4 exact lookup, and Task 5 recovery records.
- Produces: `ApprovalContext`, `ApprovalDecision`, `ConnectionWorkflowDeps`, `ConnectionRequest`, `createPostgresConnection(...)`, and `reconcileLatestConnectionRun(...)` without direct `caller.createConnection` calls.

- [ ] **Step 1: Add failing workflow tests around observable RPC ordering**

Use a dependency fixture with deterministic credentials, operation IDs, resource discovery, and run completion. Cover:

```ts
expect(requestApproval).toHaveBeenCalledWith({
  callingManagerId: 'consumer-manager',
  installsPostgres: false,
  requestedAccess: { scope: 'database', operation: 'create', database: 'orders' },
  callerLabels: { team: 'payments' },
  catalogDatabases: ['analytics'],
});
expect(caller.start).toHaveBeenCalledWith(expect.objectContaining({
  action: 'create-connection',
  runner: 'ezenki/deploy-commander-runner:latest',
  metadata: expect.objectContaining({ connections: expect.any(Object) }),
}));
expect(caller.createConnection).toBeUndefined();
```

Test explicit rejection, labels-only user configuration, installation before access, approval before returning an exact duplicate, multiple identities, conflicting duplicate labels (`409`), new collision (`409`), missing existing database (`404`), successful post-run lookup, failed-run compensation by mode, abort behavior, ambiguous start correlation, and recovery after a committed connection response is lost.

- [ ] **Step 2: Run workflow tests and verify failure**

Run: `cd postgres-interface && npm test -- src/lib/createPostgresConnection.test.ts`

Expected: FAIL because the old workflow uses remembered permission, generates its own database, and directly calls `createConnection`.

- [ ] **Step 3: Define approval and workflow boundaries**

Use these interfaces:

```ts
export interface ApprovalContext {
  callingManagerId: string;
  installsPostgres: boolean;
  requestedAccess: AccessRequest | null;
  callerLabels: Record<string, string>;
  catalogDatabases: string[];
}

export type ApprovalDecision =
  | { allowed: false }
  | { allowed: true; access: AccessRequest };

export interface ConnectionRequest {
  currentManagerId: string;
  callingManagerId: string;
  metadata: ParsedConnectionRequest;
}
```

Remove `storage`, `isPermissionRemembered`, and `rememberPermission` from the workflow dependencies.

- [ ] **Step 4: Implement the approved runner-native sequence**

Keep resource contradiction and installation recovery checks. Gather catalog database names only when an installation resource exists. Always call `requestApproval`; verify a manager-supplied complete request is returned unchanged, while a labels-only request may return any valid configured `AccessRequest`.

After approval:

1. Install PostgreSQL if needed and refresh the authoritative resource.
2. Perform exact lookup with final labels.
3. Return an agreed exact connection or throw `PostgresRequestError(409, ...)` for conflict.
4. Generate login credentials and operation identity.
5. Start the Task 3 runner plan using the object-form `caller.start({ action, runner, metadata, note })` overload.
6. Wait for terminal state.
7. Re-run exact lookup and require one match.
8. On failed/ambiguous persistence, run mode-specific cleanup and reconcile again before emitting a normalized error.

Delete every direct `caller.createConnection(...)` branch. Preserve exact-once close behavior in the component rather than the workflow.

- [ ] **Step 5: Run workflow, recovery, and contract suites**

Run:

```bash
cd postgres-interface
npm test -- src/lib/createPostgresConnection.test.ts src/lib/connectionRuns.test.ts src/lib/postgresConnectionContract.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit runner-native orchestration**

```bash
git add postgres-interface/src/lib/createPostgresConnection.ts postgres-interface/src/lib/createPostgresConnection.test.ts
git commit -m "feat: orchestrate approved postgres access"
```

### Task 7: Mandatory Approval and User Configuration UI

**Files:**
- Delete: `postgres-interface/src/components/PermissionDialog.tsx`
- Delete: `postgres-interface/src/components/PermissionDialog.test.tsx`
- Create: `postgres-interface/src/components/ConnectionApprovalDialog.tsx`
- Create: `postgres-interface/src/components/ConnectionApprovalDialog.test.tsx`
- Modify: `postgres-interface/src/components/ConnectionRequest.tsx:1-158`
- Modify: `postgres-interface/src/components/ConnectionRequest.test.tsx:1-165`

**Interfaces:**
- Consumes: `ApprovalContext`, `ApprovalDecision`, `AccessRequest`, and `generateDatabaseName`.
- Produces: accessible `ConnectionApprovalDialog` and a `ConnectionRequest` controller that always waits for one explicit decision.

- [ ] **Step 1: Write failing component tests for both UI modes**

Test read-only manager requests:

```ts
renderDialog({
  context: {
    callingManagerId: 'consumer-manager',
    installsPostgres: false,
    requestedAccess: { scope: 'database', operation: 'existing', database: 'orders' },
    callerLabels: { team: 'payments' },
    catalogDatabases: ['orders'],
  },
});
expect(screen.getByText('orders')).toBeVisible();
expect(screen.queryByRole('textbox', { name: /database name/i })).not.toBeInTheDocument();
expect(screen.getByText('team=payments')).toBeVisible();
```

Test configurable requests by selecting create/existing/full, manual and generated names, catalog options, constrained and superuser modes, invalid-name disabled approval, visible generated name, superuser warning, labels, installation notice, focus trap, Escape rejection, busy state, and no remember checkbox.

- [ ] **Step 2: Run component tests and confirm missing component failure**

Run: `cd postgres-interface && npm test -- src/components/ConnectionApprovalDialog.test.tsx src/components/ConnectionRequest.test.tsx`

Expected: FAIL because the new dialog does not exist.

- [ ] **Step 3: Implement the focused approval dialog**

Use:

```ts
export interface ConnectionApprovalDialogProps {
  context: ApprovalContext;
  busy: boolean;
  onApprove: (access: AccessRequest) => void;
  onReject: () => void;
  generateName?: () => string;
}
```

Keep form state inside the dialog only when `requestedAccess === null`. For a complete request, render a review summary and pass that exact object to `onApprove`. For generated names, set the generated value into the visible database-name field before approval. Keep `useDialogFocus` and accessible dialog labeling.

- [ ] **Step 4: Refactor `ConnectionRequest` into a thin async/UI controller**

Pass parsed metadata through its props, replace the pending permission callback with `ApprovalDecision`, remove all storage selection, and map `PostgresRequestError.status` directly to the approved normalized public messages. Keep abort-on-unmount and `closeOnce` semantics.

The controller must render progress plus `ConnectionApprovalDialog` while awaiting a decision, then render only progress while the runner is active.

- [ ] **Step 5: Run component and accessibility-focused tests**

Run:

```bash
cd postgres-interface
npm test -- src/components/ConnectionApprovalDialog.test.tsx src/components/ConnectionRequest.test.tsx src/components/ConfirmDialog.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit mandatory approval UI**

```bash
git add -A postgres-interface/src/components/PermissionDialog.tsx postgres-interface/src/components/PermissionDialog.test.tsx postgres-interface/src/components/ConnectionApprovalDialog.tsx postgres-interface/src/components/ConnectionApprovalDialog.test.tsx postgres-interface/src/components/ConnectionRequest.tsx postgres-interface/src/components/ConnectionRequest.test.tsx
git commit -m "feat: add postgres access approval flow"
```

### Task 8: Application Routing and Remembered-Permission Removal

**Files:**
- Modify: `postgres-interface/src/App.tsx:1-95`
- Modify: `postgres-interface/src/App.test.tsx:1-58`
- Modify: `postgres-interface/src/components/ManagerDashboard.tsx:1-54`
- Modify: `postgres-interface/src/components/ManagerDashboard.test.tsx:1-20`
- Delete: `postgres-interface/src/lib/permissionPreference.ts`
- Delete: `postgres-interface/src/lib/permissionPreference.test.ts`
- Modify: `postgres-interface/src/lib/postgresContracts.ts:40-61`
- Modify: `postgres-interface/src/lib/postgresContracts.test.ts:1-60`

**Interfaces:**
- Consumes: `parseConnectionRequest(await caller.getMetadata())`.
- Produces: App connection view containing validated `ParsedConnectionRequest`; dashboard props without permission storage state.

- [ ] **Step 1: Add failing routing and dashboard tests**

In `App.test.tsx`, assert all valid variants enter connection mode and malformed `create-connection` metadata closes with a normalized `400` instead of silently opening the dashboard. Assert the parsed labels/access reach the connection request UI.

In `ManagerDashboard.test.tsx`, assert the installed dashboard always says approval is requested for every connection and contains no reset-approval button.

- [ ] **Step 2: Run App and dashboard tests and verify failure**

Run: `cd postgres-interface && npm test -- src/App.test.tsx src/components/ManagerDashboard.test.tsx`

Expected: FAIL because App currently uses a one-key predicate and the dashboard still accepts remembered-permission props.

- [ ] **Step 3: Route validated metadata through App**

Change the connection view to:

```ts
type View =
  | { kind: 'connection'; manager: string; callerId: string | null; metadata: ParsedConnectionRequest; error: string | null }
  | DashboardView
  | ErrorView;
```

Detect `action === 'create-connection'`, parse it strictly, and pass the parsed value to `ConnectionRequest`. Keep trusted manager lookup separate. A malformed connection request is a connection-mode `400`, not a dashboard fallback.

- [ ] **Step 4: Remove remembered-permission code and dashboard controls**

Delete the preference module and tests. Remove `permissionRemembered`, `onResetPermission`, `localStorage`, and related imports from App and dashboard. Replace the installed-state copy with:

```tsx
<dd className="mt-1 text-sm text-slate-800">
  Required for every connection request
</dd>
```

Remove the obsolete `isCreateConnectionMetadata` predicate from `postgresContracts.ts`; the Task 1 parser is the sole request boundary.

- [ ] **Step 5: Run App, dashboard, and full unit tests**

Run:

```bash
cd postgres-interface
npm test -- src/App.test.tsx src/components/ManagerDashboard.test.tsx
npm test
npm run build
```

Expected: all non-integration tests PASS and build PASS.

- [ ] **Step 6: Commit application integration cleanup**

```bash
git add -A postgres-interface/src/App.tsx postgres-interface/src/App.test.tsx postgres-interface/src/components/ManagerDashboard.tsx postgres-interface/src/components/ManagerDashboard.test.tsx postgres-interface/src/lib/permissionPreference.ts postgres-interface/src/lib/permissionPreference.test.ts postgres-interface/src/lib/postgresContracts.ts postgres-interface/src/lib/postgresContracts.test.ts
git commit -m "refactor: require approval for every postgres request"
```

### Task 9: Consumer Guide, Formatting Baseline, and Final Verification

**Files:**
- Modify: `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md:1-225`
- Modify: all Prettier-supported files under `postgres-interface/` through the formatter

**Interfaces:**
- Consumes: the completed public child-interface, runner-plan, label, result, and error contracts.
- Produces: a copy-paste-ready consumer guide and a repository-wide formatting check for the interface package.

- [ ] **Step 1: Rewrite guide contract examples before implementation assertions**

Document these exact request examples:

```json
{ "action": "create-connection", "labels": { "team": "payments" } }
```

```json
{
  "action": "create-connection",
  "scope": "database",
  "operation": "create",
  "database": "orders",
  "labels": { "environment": "production" }
}
```

```json
{
  "action": "create-connection",
  "scope": "database",
  "operation": "existing",
  "database": "warehouse"
}
```

```json
{ "action": "create-connection", "scope": "full", "superuser": false }
```

```json
{ "action": "create-connection", "scope": "full", "superuser": true }
```

Explain mandatory approval, read-only manager proposals, user configuration, UUID name generation, reserved labels, multiple identities, catalog limitations, exact returned access metadata, normalized statuses, recovery, and secret handling. Remove every statement claiming only one metadata field, remembered approval, or one connection per manager/resource.

- [ ] **Step 2: Add a documentation contract test**

Create an assertion in `postgresConnectionRequest.test.ts` that the parser accepts each guide JSON object represented as a fixture constant and rejects both reserved labels. This keeps guide examples synchronized with executable request parsing.

- [ ] **Step 3: Run Prettier write and inspect the formatting-only surface**

Run:

```bash
cd postgres-interface
npm run format
cd ..
git diff --stat
git diff --check
```

Expected: Prettier formats interface source/config/tests and the PostgreSQL guide; no whitespace errors. Inspect the diff to ensure the two authoritative general guides were not reformatted.

- [ ] **Step 4: Run every deterministic quality gate**

Run:

```bash
cd postgres-interface
npm run format:check
npm run lint
npm test
npm run build
```

Expected: format check PASS, ESLint PASS, all ordinary Vitest tests PASS with only the environment-gated PostgreSQL integration suite skipped, and Vite production build PASS.

- [ ] **Step 5: Run opt-in PostgreSQL integration verification when Docker is available**

Run the repository's prepared PostgreSQL container workflow, then:

```bash
cd postgres-interface
POSTGRES_INTEGRATION_CONTAINER=deploy-commander-postgres-integration \
POSTGRES_INTEGRATION_PASSWORD=integration_only_password \
npm test -- src/lib/postgresIntegration.test.ts
```

Expected: new, existing, constrained-full, superuser, collision, and compensation cases PASS; test output contains neither administrator nor generated login passwords.

- [ ] **Step 6: Commit docs and formatting**

```bash
git add docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md postgres-interface
git commit -m "docs: publish postgres connection request contract"
```

- [ ] **Step 7: Record final evidence**

Run:

```bash
git status --short
git log -10 --oneline --decorate
```

Expected: clean working tree and one focused commit for each completed task. Include exact format, lint, test, build, and integration outcomes in the handoff; distinguish a skipped integration suite from a passing one.
