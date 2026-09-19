# PostgreSQL Resource and Connection Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manager-database and completed-run state with resource-authoritative installation state and label-authoritative connection state, including safe final-managed-database cleanup and direct installation.

**Architecture:** Exact owned resources determine durable installation state; resource-scoped connections and reserved labels determine logical access and database ownership. Active runs are transient progress/serialization signals only, while each action observes only the exact run it starts. Create, delete, and teardown keep their approval gates; the Install button starts installation directly.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Vite, `@ezenki/deploy-commander-installer-interface`, Deploy Commander runner plans, PostgreSQL 15 shell/SQL programs.

**Spec:** `docs/superpowers/specs/2026-09-19-postgres-resource-connection-authority-design.md`

## Global Constraints

- Production code must not call `databaseQuery` or emit a runner database-query hook.
- Durable lifecycle decisions use exact owned resources and connections only; completed run history never overrides them.
- Active queued/running runs may be used only for progress, mutation exclusion, and observation of the exact current operation.
- New database connections use reserved labels `postgres.access`, `postgres.database`, and `postgres.database-origin`.
- `postgres.database-origin` is exactly `managed` or `existing`; full-access connections carry neither database label.
- Only the final database-scoped connection to a `managed` database may trigger database deletion.
- Legacy origin may be derived from validated connection metadata; uncertainty always preserves the database.
- Install starts from the first button click without a popup; create connection, delete connection, and teardown remain approval-gated.
- No state-changing RPC occurs before the approval required for that action.
- Administrator credentials, logical credentials, raw RPC payloads, SQL, runner metadata, and connection strings never enter labels, logs, UI text, or wire errors.
- Do not add dependencies or change the installer-interface package version.
- Preserve the existing `postgres-action-approval-gate-v1` build marker.
- Publishing or deployment is outside this plan and requires separate authorization.

## Review Focus

- A target's peer set changes after delete approval: Task 6 tests that cleanup consequence changes return 409 and perform no cleanup or deletion.
- A legacy database connection lacks origin and has malformed access metadata: Tasks 1 and 6 test that the role/connection may be removed only through a valid target contract and the database is never dropped.
- A resource exists but has incomplete operational configuration: Tasks 3 and 7 test that the dashboard remains installed while create/delete return the specific configuration error.
- Active-run pagination or envelopes are malformed: Task 3 tests fail-closed behavior without consulting completed history.
- Caller labels attempt to spoof any reserved PostgreSQL key: Tasks 1 and 5 test rejection before approval can authorize a mislabeled connection.

---

### Task 1: Define the authoritative connection-label contract

**Files:**

- Modify: `postgres-interface/src/lib/postgresConnectionRequest.ts`
- Modify: `postgres-interface/src/lib/postgresConnectionRequest.test.ts`
- Modify: `postgres-interface/src/lib/postgresPlans.ts`
- Modify: `postgres-interface/src/lib/postgresPlans.test.ts`
- Modify: `postgres-interface/src/lib/postgresConnectionContract.ts`
- Modify: `postgres-interface/src/lib/postgresConnectionContract.test.ts`

**Interfaces:**

- Consumes: existing `AccessRequest`, parsed caller labels, and validated connection metadata access.
- Produces: `DatabaseOrigin`, `POSTGRES_DATABASE_ORIGIN_LABEL`, `connectionLabels(access, callerLabels, origin)`, and `resolveDatabaseOrigin(access, labels)` for Tasks 2, 4, 5, and 6.

- [ ] **Step 1: Add failing tests for reserved labels and origin resolution**

Add cases equivalent to:

```ts
expect(() =>
  parseConnectionRequest({
    action: 'create-connection',
    labels: { 'postgres.database-origin': 'managed' },
  }),
).toThrow('label is reserved');

expect(
  connectionLabels(
    { scope: 'database', operation: 'create', database: 'orders' },
    { team: 'checkout' },
    'managed',
  ),
).toEqual({
  team: 'checkout',
  'postgres.access': 'database',
  'postgres.database': 'orders',
  'postgres.database-origin': 'managed',
});

expect(connectionLabels({ scope: 'full', superuser: false }, {}, null)).toEqual({
  'postgres.access': 'full',
});

expect(
  resolveDatabaseOrigin(
    { scope: 'database', operation: 'create', database: 'orders' },
    { 'postgres.access': 'database', 'postgres.database': 'orders' },
  ),
).toEqual({ origin: 'managed', legacy: true });

expect(() =>
  resolveDatabaseOrigin(
    { scope: 'database', operation: 'existing', database: 'orders' },
    {
      'postgres.access': 'database',
      'postgres.database': 'orders',
      'postgres.database-origin': 'invalid',
    },
  ),
).toThrow('Invalid PostgreSQL connection labels');
```

Also test mismatched access/database labels, database labels on full access, and missing origin with malformed access.

- [ ] **Step 2: Run the focused tests and confirm red**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/postgresConnectionRequest.test.ts
```

Expected: FAIL because the origin label, origin type, and resolver do not exist.

- [ ] **Step 3: Implement the label contract**

Add these public contracts and include the new key in `RESERVED_CONNECTION_LABELS`:

```ts
export type DatabaseOrigin = 'managed' | 'existing';

export const POSTGRES_DATABASE_ORIGIN_LABEL = 'postgres.database-origin';

export interface ResolvedDatabaseOrigin {
  origin: DatabaseOrigin | null;
  legacy: boolean;
}

export const RESERVED_CONNECTION_LABELS = new Set([
  'postgres.access',
  'postgres.database',
  POSTGRES_DATABASE_ORIGIN_LABEL,
]);
```

Change label construction to require a database origin and prohibit one for full access:

```ts
export function connectionLabels(
  access: AccessRequest,
  callerLabels: Record<string, string>,
  origin: DatabaseOrigin | null,
): Record<string, string> {
  const labels = parseLabels(callerLabels);
  labels['postgres.access'] = access.scope;
  if (access.scope === 'database') {
    if (origin === null) throw new Error('Database origin is required');
    labels['postgres.database'] = access.database;
    labels[POSTGRES_DATABASE_ORIGIN_LABEL] = origin;
  } else if (origin !== null) {
    throw new Error('Full access cannot have a database origin');
  }
  return labels;
}
```

Implement `resolveDatabaseOrigin` so complete labels are validated exactly; absent origin falls back only to a valid database access operation; full access rejects database/origin labels. Use `PostgresRequestError(409, 'Invalid PostgreSQL connection labels')` for invalid combinations.

- [ ] **Step 4: Update direct callers temporarily and run the focused suite**

Until Tasks 4 and 5 compute inherited origin, pass the access-derived origin at existing call sites:

```ts
const origin =
  access.scope === 'database' ? (access.operation === 'create' ? 'managed' : 'existing') : null;
connectionLabels(access, callerLabels, origin);
```

Run:

```bash
cd postgres-interface
npx vitest run src/lib/postgresConnectionRequest.test.ts src/lib/postgresPlans.test.ts src/lib/postgresConnectionContract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add postgres-interface/src/lib/postgresConnectionRequest.ts postgres-interface/src/lib/postgresConnectionRequest.test.ts postgres-interface/src/lib/postgresPlans.ts postgres-interface/src/lib/postgresPlans.test.ts postgres-interface/src/lib/postgresConnectionContract.ts postgres-interface/src/lib/postgresConnectionContract.test.ts
git commit -m "feat: define postgres connection origin labels"
```

---

### Task 2: Build a resource-wide connection inventory

**Files:**

- Modify: `postgres-interface/src/lib/postgresConnectionContract.ts`
- Modify: `postgres-interface/src/lib/postgresConnectionContract.test.ts`

**Interfaces:**

- Consumes: `DatabaseOrigin`, `resolveDatabaseOrigin`, `AccessRequest`, `PlatformConnection`, `RPCCaller.getConnections`, and `RPCCaller.getConnection`.
- Produces: `PostgresConnectionTarget.origin`, `listResourcePostgresConnections`, `databaseConnectionState`, and database suggestions for create and delete workflows.

- [ ] **Step 1: Write failing inventory tests**

Add tests that prove the inventory:

```ts
const targets = await listResourcePostgresConnections(caller, 'resource-1', platform);
expect(caller.getConnections).toHaveBeenCalledWith({
  resource: 'resource-1',
  include_labels: true,
  limit: 50,
  offset: 0,
});
expect(targets.map(({ managerId, database, origin }) => ({ managerId, database, origin }))).toEqual(
  [
    { managerId: 'consumer-a', database: 'orders', origin: 'managed' },
    { managerId: 'consumer-b', database: 'orders', origin: 'managed' },
  ],
);
```

Cover multiple pages, multiple managers, full access, other resources, duplicate IDs, label/detail disagreement, consistent legacy origin, conflicting origin, and an unknown legacy origin that resolves to `null` without authorizing database deletion.

Test the derived state:

```ts
expect(databaseConnectionState(targets, 'orders')).toEqual({
  database: 'orders',
  origin: 'managed',
  connectionIds: ['connection-a', 'connection-b'],
});
expect(databaseSuggestions(targets)).toEqual(['orders']);
```

- [ ] **Step 2: Run the inventory tests and confirm red**

```bash
cd postgres-interface
npx vitest run src/lib/postgresConnectionContract.test.ts --testNamePattern="resource inventory|database state|origin"
```

Expected: FAIL because resource-wide enumeration and database state helpers do not exist.

- [ ] **Step 3: Implement resource-wide enumeration**

Extend the target contract:

```ts
export interface PostgresConnectionTarget {
  id: string;
  managerId: string;
  resourceId: string;
  username: string;
  password: string;
  access: AccessRequest;
  origin: DatabaseOrigin | null;
  platform: PlatformConnection;
  labels: Record<string, string>;
}
```

Add resource-scoped enumeration without a manager filter:

```ts
export async function listResourcePostgresConnections(
  caller: RPCCaller,
  resourceId: string,
  platform: PlatformConnection,
): Promise<PostgresConnectionTarget[]>;
```

It must paginate `getConnections({ resource, include_labels: true, limit: 50, offset })`, validate each summary, fetch and validate each complete connection, require exact resource identity, derive origin with `resolveDatabaseOrigin`, and reject duplicate or changing pagination.

Add:

```ts
export interface DatabaseConnectionState {
  database: string;
  origin: DatabaseOrigin | null;
  connectionIds: string[];
}

export function databaseConnectionState(
  targets: PostgresConnectionTarget[],
  database: string,
): DatabaseConnectionState;

export function databaseSuggestions(targets: PostgresConnectionTarget[]): string[];
```

`databaseConnectionState` considers only database-scoped targets with an exact database match. Conflicting non-null origins throw `PostgresRequestError(409, 'Conflicting PostgreSQL database origin for ' + database)`. Any unknown origin makes the aggregate origin `null`.

- [ ] **Step 4: Reimplement caller-owned enumeration as a filter over the same validated contract**

Keep the public function used by delete selection:

```ts
export async function listOwnedPostgresConnections(
  caller: RPCCaller,
  managerId: string,
  resourceId: string,
  platform: PlatformConnection,
): Promise<PostgresConnectionTarget[]> {
  return (await listResourcePostgresConnections(caller, resourceId, platform)).filter(
    (target) => target.managerId === managerId,
  );
}
```

Do not trust the filter alone: complete-record validation must already have verified each target's manager/resource identity.

- [ ] **Step 5: Run the complete connection-contract suite**

```bash
cd postgres-interface
npx vitest run src/lib/postgresConnectionContract.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add postgres-interface/src/lib/postgresConnectionContract.ts postgres-interface/src/lib/postgresConnectionContract.test.ts
git commit -m "feat: derive postgres database state from connections"
```

---

### Task 3: Make resources authoritative and runs transient

**Files:**

- Modify: `postgres-interface/src/lib/postgresErrors.ts`
- Modify: `postgres-interface/src/lib/postgresResource.ts`
- Modify: `postgres-interface/src/lib/postgresResource.test.ts`
- Modify: `postgres-interface/src/lib/postgresRuns.ts`
- Modify: `postgres-interface/src/lib/postgresRuns.test.ts`
- Modify: `postgres-interface/src/lib/lifecycleActions.ts`
- Modify: `postgres-interface/src/lib/lifecycleActions.test.ts`
- Modify: `postgres-interface/src/App.tsx`
- Modify: `postgres-interface/src/App.test.tsx`

**Interfaces:**

- Consumes: exact resource discovery, `RPCCaller.getRuns`, exact-run reads, and lifecycle action runners.
- Produces: specific resource errors, `ActivePostgresRun`, `readActivePostgresRun`, and `resolvePostgresLifecycle(resources, activeRun)` for all workflows and dashboard rendering.

- [ ] **Step 1: Write failing resource-authority tests**

Add tests equivalent to:

```ts
expect(resolvePostgresLifecycle([], null)).toEqual({ kind: 'not-installed' });
expect(resolvePostgresLifecycle([resource], null)).toEqual({
  kind: 'installed',
  operationBusy: false,
});
expect(
  resolvePostgresLifecycle([resource], { action: 'create-connection', runId: 'run-1' }),
).toEqual({
  kind: 'installed',
  operationBusy: true,
});
expect(resolvePostgresLifecycle([], { action: 'create', runId: 'run-1' })).toEqual({
  kind: 'installing',
  runId: 'run-1',
});
expect(resolvePostgresLifecycle([resource], { action: 'teardown', runId: 'run-2' })).toEqual({
  kind: 'tearing-down',
  runId: 'run-2',
});
```

Prove completed runs are ignored by returning them from an unfiltered mock while the required active-run query returns none. Add invalid active-page tests for total changes, duplicate IDs, non-active status, and short nonterminal pagination.

Add an App test where an exact resource has incomplete details: the dashboard must still render “PostgreSQL is installed,” while no compatibility/recovery panel appears.

- [ ] **Step 2: Run the lifecycle tests and confirm red**

```bash
cd postgres-interface
npx vitest run src/lib/postgresRuns.test.ts src/lib/postgresResource.test.ts src/lib/lifecycleActions.test.ts src/App.test.tsx --testNamePattern="resource|active|completed|configuration|install|teardown"
```

Expected: FAIL because lifecycle is still derived from the latest completed run and App treats incomplete details as non-installed recovery.

- [ ] **Step 3: Add specific resource errors**

Define:

```ts
export class PostgresNotInstalledError extends Error {
  constructor() {
    super('PostgreSQL is not installed');
    this.name = 'PostgresNotInstalledError';
  }
}

export class PostgresResourceAmbiguousError extends Error {
  constructor() {
    super('Multiple PostgreSQL resources were found');
    this.name = 'PostgresResourceAmbiguousError';
  }
}

export class PostgresResourceConfigurationError extends Error {
  constructor() {
    super('PostgreSQL resource configuration is incomplete');
    this.name = 'PostgresResourceConfigurationError';
  }
}
```

Make `readPostgresInstallation` throw `PostgresResourceConfigurationError` for invalid details or failed `getResource`. Keep resource-list transport/envelope failures normalized separately; zero and multiple valid exact resources are handled by workflow helpers, not as malformed pages.

- [ ] **Step 4: Replace completed-run lifecycle resolution**

Remove `readLatestRun`, `readPostgresLifecycle`, `listRunsByAction`, and completed-run lifecycle branches. Keep `readExactRun` and note correlation for the exact action being started.

Add:

```ts
export type ActivePostgresRun = {
  action: 'create' | 'teardown' | 'create-connection' | 'cleanup-connection';
  runId: string;
};

export async function readActivePostgresRun(caller: RPCCaller): Promise<ActivePostgresRun | null>;

export function resolvePostgresLifecycle(
  resources: RPC.ResourceItem[],
  active: ActivePostgresRun | null,
): PostgresLifecycle;
```

`readActivePostgresRun` calls `getRuns({ statuses: ['0', '1'], sort: '-created_at', limit: 50, offset })`, validates every page and action, and returns null, one active run, or throws `OperationBusyError` when multiple PostgreSQL mutations are active. It never requests terminal statuses.

- [ ] **Step 5: Update lifecycle actions and App boot**

Use this state read in `lifecycleActions.ts`:

```ts
const [resources, active] = await Promise.all([
  listPostgresResources(deps.caller),
  readActivePostgresRun(deps.caller),
]);
```

Installation requires `resources.length === 0` and `active === null`. Teardown requires at least one resource and `active === null`; it does not load operational configuration.

In App dashboard boot, list resources and active runs, then call `resolvePostgresLifecycle(resources, active)`. Remove `compatible`, `contradiction`, and completed-run-derived branches from `DashboardView` and `ManagerDashboard` props in Task 7; until then pass fixed values that keep the dashboard compiling.

- [ ] **Step 6: Run focused lifecycle tests**

```bash
cd postgres-interface
npx vitest run src/lib/postgresRuns.test.ts src/lib/postgresResource.test.ts src/lib/lifecycleActions.test.ts src/App.test.tsx --testNamePattern="resource|active|completed|configuration|install|teardown"
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add postgres-interface/src/lib/postgresErrors.ts postgres-interface/src/lib/postgresResource.ts postgres-interface/src/lib/postgresResource.test.ts postgres-interface/src/lib/postgresRuns.ts postgres-interface/src/lib/postgresRuns.test.ts postgres-interface/src/lib/lifecycleActions.ts postgres-interface/src/lib/lifecycleActions.test.ts postgres-interface/src/App.tsx postgres-interface/src/App.test.tsx
git commit -m "refactor: derive postgres lifecycle from resources"
```

---

### Task 4: Remove the manager-database catalog and runner query hooks

**Files:**

- Delete: `postgres-interface/src/lib/postgresCatalog.ts`
- Delete: `postgres-interface/src/lib/postgresCatalog.test.ts`
- Modify: `postgres-interface/src/lib/postgresContracts.ts`
- Modify: `postgres-interface/src/lib/postgresContracts.test.ts`
- Modify: `postgres-interface/src/lib/postgresPlans.ts`
- Modify: `postgres-interface/src/lib/postgresPlans.test.ts`
- Modify: `postgres-interface/src/lib/connectionRuns.ts`
- Modify: `postgres-interface/src/lib/connectionRuns.test.ts`
- Modify: `postgres-interface/src/lib/createPostgresConnection.ts`
- Modify: `postgres-interface/src/lib/createPostgresConnection.test.ts`
- Modify: `postgres-interface/src/lib/finalHardening.test.ts`

**Interfaces:**

- Consumes: Task 1 label construction and Task 2 connection-derived database suggestions.
- Produces: catalog-free `RunnerMetadata`, `ConnectionRunPlanInput.origin`, cleanup plans without hooks, and run parsers that validate only runner services/connections.

- [ ] **Step 1: Add failing no-catalog plan and parser tests**

Update plan expectations:

```ts
const plan = buildConnectionRunPlan({
  administrator,
  login,
  access: { scope: 'database', operation: 'create', database: 'orders' },
  origin: 'managed',
  callerId: 'consumer-manager',
  resourceId: 'resource-1',
  platform,
  callerLabels: {},
  operationId: 'operation-1',
});

expect(plan).not.toHaveProperty('object_hooks');
expect(plan.connections?.create[0].labels).toMatchObject({
  'postgres.access': 'database',
  'postgres.database': 'orders',
  'postgres.database-origin': 'managed',
});
expect(JSON.stringify(plan)).not.toContain('postgres_database');
```

Update cleanup plan tests to expect service-only metadata with no `catalogOperationId`. Update run parser fixtures so valid v2 runs have no object hooks and no catalog operation ID.

- [ ] **Step 2: Run plan/parser tests and confirm red**

```bash
cd postgres-interface
npx vitest run src/lib/postgresPlans.test.ts src/lib/connectionRuns.test.ts src/lib/postgresContracts.test.ts
```

Expected: FAIL because catalog hooks and catalog parser requirements still exist.

- [ ] **Step 3: Remove catalog types and hooks**

Delete `DatabaseQuery` and `ObjectHooks` from `postgresContracts.ts`, and remove `object_hooks` from `RunnerMetadata` if no other production plan uses it.

Delete catalog imports from `postgresPlans.ts`. Change inputs to:

```ts
export interface CleanupPlanInput {
  administrator: AdminCredentials;
  login: LoginCredentials;
  access: AccessRequest;
  resourceId: string;
  platform: PlatformConnection;
}

export interface ConnectionRunPlanInput {
  administrator: AdminCredentials;
  login: LoginCredentials;
  access: AccessRequest;
  origin: DatabaseOrigin | null;
  callerId: string;
  resourceId: string;
  platform: PlatformConnection;
  callerLabels: Record<string, string>;
  operationId: string;
}
```

Return only the access service and connection create definition:

```ts
return {
  ...service,
  connections: {
    create: [
      {
        name: 'postgres-connection',
        manager: input.callerId,
        resource: { id: input.resourceId },
        metadata,
        labels: connectionLabels(input.access, input.callerLabels, input.origin),
      },
    ],
  },
};
```

- [ ] **Step 4: Simplify connection-run parsing**

Remove catalog imports, hook validators, `catalogOperationId`, and legacy catalog branches from `connectionRuns.ts`. Continue validating exact run identity, action, note, service environment, access, login, resource ID, platform connection, and published connection definition. Require complete origin labels for newly created v2 connections; preserve the existing v1 parser only where a published legacy connection still needs validation.

- [ ] **Step 5: Remove catalog calls from the current create workflow**

Replace `listCatalogDatabases` with Task 2 inventory suggestions:

```ts
const resourceConnections = await listResourcePostgresConnections(
  deps.caller,
  installation.resource.id,
  installation.platform,
);
const availableDatabases = databaseSuggestions(resourceConnections);
```

Keep the existing `ApprovalContext.catalogDatabases` property temporarily, but populate it from `databaseSuggestions(resourceConnections)` so this task remains compile-safe and focused on storage removal. Task 5 renames the UI contract. Delete `confirmCatalogCleanup` calls and all catalog-operation parameters. Current-run cleanup retry remains service-only until Task 5 removes completed-run reconciliation.

- [ ] **Step 6: Delete the catalog module and run focused tests**

Delete both catalog files, then run:

```bash
cd postgres-interface
npx vitest run src/lib/postgresPlans.test.ts src/lib/connectionRuns.test.ts src/lib/postgresContracts.test.ts src/lib/createPostgresConnection.test.ts src/lib/finalHardening.test.ts
rg -n "databaseQuery|postgres_database|CATALOG_|postgresCatalog|object_hooks" src --glob '!**/*.test.*'
```

Expected: tests PASS; `rg` produces no output and exits 1.

- [ ] **Step 7: Commit Task 4**

```bash
git add \
  postgres-interface/src/lib/postgresCatalog.ts \
  postgres-interface/src/lib/postgresCatalog.test.ts \
  postgres-interface/src/lib/postgresContracts.ts \
  postgres-interface/src/lib/postgresContracts.test.ts \
  postgres-interface/src/lib/postgresPlans.ts \
  postgres-interface/src/lib/postgresPlans.test.ts \
  postgres-interface/src/lib/connectionRuns.ts \
  postgres-interface/src/lib/connectionRuns.test.ts \
  postgres-interface/src/lib/createPostgresConnection.ts \
  postgres-interface/src/lib/createPostgresConnection.test.ts \
  postgres-interface/src/lib/finalHardening.test.ts
git commit -m "refactor: remove postgres manager database catalog"
```

---

### Task 5: Simplify create connection around resources and connections

**Files:**

- Modify: `postgres-interface/src/lib/createPostgresConnection.ts`
- Modify: `postgres-interface/src/lib/createPostgresConnection.test.ts`
- Modify: `postgres-interface/src/components/ConnectionApprovalDialog.tsx`
- Modify: `postgres-interface/src/components/ConnectionApprovalDialog.test.tsx`
- Modify: `postgres-interface/src/components/ConnectionRequest.tsx`
- Modify: `postgres-interface/src/components/ConnectionRequest.test.tsx`

**Interfaces:**

- Consumes: Task 2 inventory/origin helpers, Task 3 resource and active-run APIs, Task 4 catalog-free plans, and the existing approval gate.
- Produces: `ApprovalContext.databaseSuggestions`, resource-required approved provisioning, and exact-current-run verification without completed-history reconstruction.

- [ ] **Step 1: Write failing create-workflow tests**

Add tests for these exact behaviors:

```ts
await expect(run({ resources: [] })).rejects.toThrow('PostgreSQL is not installed');
expect(caller.start).not.toHaveBeenCalled();

const approval = deferred<ApprovalDecision>();
const promise = run({ requestApproval: () => approval.promise });
await waitForApproval();
expect(caller.start).not.toHaveBeenCalled();
approval.resolve({
  allowed: true,
  access: { scope: 'database', operation: 'existing', database: 'orders' },
});
await promise;
```

Cover:

- no automatic install when no resource exists;
- database suggestions derived from connections;
- `create` resolves to `managed`;
- unconnected `existing` resolves to `existing`;
- connected `existing` inherits a consistent `managed` origin;
- full access uses null origin and no database labels;
- active mutation blocks before `start`;
- completed runs are never listed or reconciled;
- revalidation after approval catches resource/connection changes;
- reserved-label spoofing fails before any mutation;
- an exact existing connection returns idempotently;
- a successful current run must publish the expected labeled connection.

- [ ] **Step 2: Run create tests and confirm red**

```bash
cd postgres-interface
npx vitest run src/lib/createPostgresConnection.test.ts src/components/ConnectionApprovalDialog.test.tsx src/components/ConnectionRequest.test.tsx
```

Expected: FAIL on automatic installation, completed-run recovery, catalog-named approval context, and missing origin inheritance.

- [ ] **Step 3: Reduce the workflow to one resource/connection path**

Delete `install`, `reconcileLatestConnectionRun`, completed cleanup/provision reconciliation, and latest-run branches from `createPostgresConnection.ts`.

Use a helper with explicit cardinality errors:

```ts
async function installation(caller: RPCCaller): Promise<PostgresInstallation> {
  const resources = await listPostgresResources(caller);
  if (resources.length === 0) throw new PostgresNotInstalledError();
  if (resources.length > 1) throw new PostgresResourceAmbiguousError();
  return readPostgresInstallation(caller, resources[0]);
}
```

Before approval, load resource connections and suggestions. After approval, repeat installation lookup, active-run lookup, and relevant connection inventory. Choose origin as:

```ts
const origin: DatabaseOrigin | null =
  access.scope === 'full'
    ? null
    : access.operation === 'create'
      ? 'managed'
      : (databaseConnectionState(resourceConnections, access.database).origin ?? 'existing');
```

If an existing database has conflicting origins, propagate the specific conflict. Pass `origin` to `buildConnectionRunPlan`.

- [ ] **Step 4: Keep only exact-current-run recovery**

Start with a unique immutable note. If the `start` response is lost, correlate only that exact action/note. Wait for that run ID; if waiting fails, read that exact run ID. Never select or scan unrelated completed runs. After success, enumerate the expected labeled connection and return it; absence returns the normalized publication failure.

- [ ] **Step 5: Update approval and request UI contracts**

Rename:

```ts
export interface ApprovalContext {
  callingManagerId: string;
  requestedAccess: AccessRequest | null;
  callerLabels: Record<string, string>;
  databaseSuggestions: string[];
}
```

Remove `installsPostgres`. Render suggestions as connection-derived suggestions, not a catalog. Map the new specific errors in `ConnectionRequest.tsx` while preserving the visible preparing/blocked/ready/executing gate and 499 rejection behavior.

- [ ] **Step 6: Run the complete create path suite**

```bash
cd postgres-interface
npx vitest run src/lib/createPostgresConnection.test.ts src/components/ConnectionApprovalDialog.test.tsx src/components/ConnectionRequest.test.tsx src/App.test.tsx --testNamePattern="create|connection|resource|approval|origin"
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add postgres-interface/src/lib/createPostgresConnection.ts postgres-interface/src/lib/createPostgresConnection.test.ts postgres-interface/src/components/ConnectionApprovalDialog.tsx postgres-interface/src/components/ConnectionApprovalDialog.test.tsx postgres-interface/src/components/ConnectionRequest.tsx postgres-interface/src/components/ConnectionRequest.test.tsx postgres-interface/src/App.test.tsx
git commit -m "refactor: create postgres connections from resource state"
```

---

### Task 6: Delete connections using final-consumer semantics

**Files:**

- Modify: `postgres-interface/src/lib/deletePostgresConnection.ts`
- Modify: `postgres-interface/src/lib/deletePostgresConnection.test.ts`
- Modify: `postgres-interface/src/components/DeleteConnectionDialog.tsx`
- Modify: `postgres-interface/src/components/DeleteConnectionDialog.test.tsx`
- Modify: `postgres-interface/src/components/DeleteConnectionRequest.tsx`
- Modify: `postgres-interface/src/components/DeleteConnectionRequest.test.tsx`

**Interfaces:**

- Consumes: Task 2 resource-wide inventory and database state, Task 3 exact resource/active run state, Task 4 service-only cleanup plans, and the existing delete approval gate.
- Produces: approval choices with explicit cleanup consequence and a deletion workflow that drops only the final managed database.

- [ ] **Step 1: Write failing cleanup-decision tests**

Extend approval choices:

```ts
export interface DeleteConnectionChoice {
  id: string;
  access: AccessRequest;
  origin: DatabaseOrigin | null;
  cleanup: 'role-only' | 'role-and-database';
}
```

Test this matrix:

```ts
it.each([
  ['full access', fullTarget, [], 'role-only'],
  ['pre-existing final', existingTarget, [], 'role-only'],
  ['managed shared', managedTarget, [managedPeer], 'role-only'],
  ['managed final', managedTarget, [], 'role-and-database'],
  ['unknown origin', unknownTarget, [], 'role-only'],
])('%s', async (_name, target, peers, expected) => {
  const context = await prepareDeletion(target, peers);
  expect(context.choices[0].cleanup).toBe(expected);
});
```

Add tests for a peer owned by another manager, peers for another resource/database, conflicting origin, active mutation, cleanup failure retaining the connection, double approval, and already-absent deletion.

Add the review-focus race test: approval says `role-only`, revalidation says `role-and-database`; expect status 409 and no `start`/`deleteConnection`. Also test the reverse change so the exact approved consequence is always re-approved.

- [ ] **Step 2: Run delete tests and confirm red**

```bash
cd postgres-interface
npx vitest run src/lib/deletePostgresConnection.test.ts src/components/DeleteConnectionDialog.test.tsx src/components/DeleteConnectionRequest.test.tsx
```

Expected: FAIL because cleanup currently follows only the target's historical `access.operation` and scans completed cleanup runs.

- [ ] **Step 3: Implement a pure cleanup decision**

Add:

```ts
export function deletionCleanup(
  target: PostgresConnectionTarget,
  resourceConnections: PostgresConnectionTarget[],
): 'role-only' | 'role-and-database' {
  if (target.access.scope !== 'database' || target.origin !== 'managed') return 'role-only';
  const peers = resourceConnections.filter(
    (candidate) =>
      candidate.id !== target.id &&
      candidate.access.scope === 'database' &&
      candidate.access.database === target.access.database,
  );
  return peers.length === 0 ? 'role-and-database' : 'role-only';
}
```

Unknown or conflicting origins never produce `role-and-database`.

- [ ] **Step 4: Replace completed cleanup reconciliation**

Delete `matchingCleanupRuns`, `listRunsByAction`, and historical cleanup parsing from `deletePostgresConnection.ts`. Start one idempotent cleanup for the approved, revalidated target. A lost start response may correlate the current immutable note; a failed wait may inspect only that exact run.

Build cleanup access from the approved consequence:

```ts
const cleanupAccess: AccessRequest =
  target.access.scope === 'database'
    ? {
        scope: 'database',
        operation: cleanup === 'role-and-database' ? 'create' : 'existing',
        database: target.access.database,
      }
    : target.access;
```

Run cleanup before deleting the connection. If cleanup fails, do not call `deleteConnection`.

- [ ] **Step 5: Revalidate the exact approved consequence**

After approval, reload the target and resource-wide inventory. Require target identity equality and recompute `deletionCleanup`. If target, origin, or cleanup consequence differs from the approved choice, throw `PostgresRequestError(409, 'PostgreSQL connection changed during deletion')` before mutation.

- [ ] **Step 6: Update the delete dialog and request error mapping**

Render consequence from `choice.cleanup`, not `choice.access.operation`:

```tsx
{
  choice.cleanup === 'role-and-database'
    ? 'The database and connection role will be deleted.'
    : 'Only the connection role will be deleted.';
}
```

Keep reject enabled during preparation/blocked/ready, disable dismissal during execution, and normalize specific resource/configuration/origin errors without secrets.

- [ ] **Step 7: Run the complete delete path suite**

```bash
cd postgres-interface
npx vitest run src/lib/deletePostgresConnection.test.ts src/components/DeleteConnectionDialog.test.tsx src/components/DeleteConnectionRequest.test.tsx src/App.test.tsx --testNamePattern="delete|cleanup|managed|existing|origin|approval"
```

Expected: PASS.

- [ ] **Step 8: Commit Task 6**

```bash
git add postgres-interface/src/lib/deletePostgresConnection.ts postgres-interface/src/lib/deletePostgresConnection.test.ts postgres-interface/src/components/DeleteConnectionDialog.tsx postgres-interface/src/components/DeleteConnectionDialog.test.tsx postgres-interface/src/components/DeleteConnectionRequest.tsx postgres-interface/src/components/DeleteConnectionRequest.test.tsx postgres-interface/src/App.test.tsx
git commit -m "refactor: delete postgres databases by connection usage"
```

---

### Task 7: Make installation direct and simplify dashboard states

**Files:**

- Modify: `postgres-interface/src/components/ManagerDashboard.tsx`
- Modify: `postgres-interface/src/components/ManagerDashboard.test.tsx`
- Modify: `postgres-interface/src/components/ConfirmDialog.tsx`
- Modify: `postgres-interface/src/components/ConfirmDialog.test.tsx`
- Modify: `postgres-interface/src/App.tsx`
- Modify: `postgres-interface/src/App.test.tsx`

**Interfaces:**

- Consumes: Task 3 resource/active-run lifecycle and existing `onInstall`, `onTeardown`, and approval components.
- Produces: direct one-click install, teardown-only confirmation, and a dashboard without compatibility/contradiction recovery state.

- [ ] **Step 1: Write failing dashboard interaction tests**

Add:

```ts
it('starts installation on the first click without a dialog', async () => {
  const user = userEvent.setup();
  const onInstall = vi.fn();
  renderDashboard({ lifecycle: { kind: 'not-installed' }, onInstall });

  await user.click(screen.getByRole('button', { name: 'Install PostgreSQL' }));

  expect(onInstall).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog', { name: 'Install PostgreSQL?' })).not.toBeInTheDocument();
});
```

Also test rapid double click starts once through the App `activeAction` guard, resource-present installed display despite incomplete details, active install/teardown progress, multiple-resource ambiguity, and teardown confirmation remaining mandatory.

- [ ] **Step 2: Run component/App tests and confirm red**

```bash
cd postgres-interface
npx vitest run src/components/ManagerDashboard.test.tsx src/components/ConfirmDialog.test.tsx src/App.test.tsx
```

Expected: FAIL because install still opens `ConfirmDialog` and dashboard still exposes resource compatibility/contradiction recovery UI.

- [ ] **Step 3: Remove install confirmation state**

Delete `confirmingInstall`, `installSubmitted`, and `requestInstall`. Wire both install buttons directly:

```tsx
<ActionButton tone="primary" disabled={busy} onClick={onInstall}>
  Install PostgreSQL
</ActionButton>
```

Remove the install-flavored `ConfirmDialog` rendering. Keep `ConfirmDialog` focused on teardown; remove generic props that no longer have another production caller only if its tests confirm no use remains.

- [ ] **Step 4: Remove obsolete recovery presentation**

Delete `resourceCompatible` and `resourceContradiction` props and the corresponding dashboard panels. Keep:

- multiple-resource ambiguity;
- active progress;
- installed/not-installed resource states;
- action-specific errors; and
- teardown confirmation.

App must not call `readPostgresInstallation` merely to decide whether the dashboard is installed.

- [ ] **Step 5: Run dashboard and App tests**

```bash
cd postgres-interface
npx vitest run src/components/ManagerDashboard.test.tsx src/components/ConfirmDialog.test.tsx src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit Task 7**

```bash
git add postgres-interface/src/components/ManagerDashboard.tsx postgres-interface/src/components/ManagerDashboard.test.tsx postgres-interface/src/components/ConfirmDialog.tsx postgres-interface/src/components/ConfirmDialog.test.tsx postgres-interface/src/App.tsx postgres-interface/src/App.test.tsx
git commit -m "fix: start postgres installation directly"
```

---

### Task 8: Update documentation and complete repository verification

**Files:**

- Modify: `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md`
- Modify: `postgres-interface/README.md`
- Modify: `postgres-interface/src/lib/postgresIntegration.test.ts`
- Modify: `postgres-interface/src/lib/finalHardening.test.ts`
- Modify: affected tests containing obsolete catalog or completed-run fixtures

**Interfaces:**

- Consumes: all prior task contracts and the approved spec.
- Produces: current integration documentation, regression coverage, and a verified production build.

- [ ] **Step 1: Replace obsolete documentation contracts**

Document these exact labels:

```text
postgres.access=database
postgres.database=<database>
postgres.database-origin=managed|existing
```

Document `postgres.access=full` separately. State that resources determine installation, connections determine logical access, active runs are transient, completed runs are not state, `databaseQuery` is unused, install has no confirmation popup, and only a final managed database connection can drop its database.

Remove manager-database catalog schema/query examples and claims that connection creation installs PostgreSQL automatically.

- [ ] **Step 2: Update integration and hardening tests**

The PostgreSQL integration test must create two roles/connections for one managed database, run role-only cleanup for the first, prove the database remains, run role-and-database cleanup for the final connection, and prove the database is absent. Preserve pre-existing database coverage and credential-redaction assertions.

Replace catalog-specific hardening cases with plan-level assertions:

```ts
const provision = buildConnectionRunPlan(input);
const cleanup = buildCleanupPlan(cleanupInput);
expect(provision).not.toHaveProperty('object_hooks');
expect(cleanup).not.toHaveProperty('object_hooks');
expect(JSON.stringify([provision, cleanup])).not.toContain('postgres_database');
```

- [ ] **Step 3: Run the focused architectural suite**

```bash
cd postgres-interface
npx vitest run \
  src/lib/postgresConnectionRequest.test.ts \
  src/lib/postgresConnectionContract.test.ts \
  src/lib/postgresResource.test.ts \
  src/lib/postgresRuns.test.ts \
  src/lib/lifecycleActions.test.ts \
  src/lib/postgresPlans.test.ts \
  src/lib/connectionRuns.test.ts \
  src/lib/createPostgresConnection.test.ts \
  src/lib/deletePostgresConnection.test.ts \
  src/components/ConnectionRequest.test.tsx \
  src/components/DeleteConnectionRequest.test.tsx \
  src/components/ManagerDashboard.test.tsx \
  src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Prove production has no manager-database path**

```bash
cd postgres-interface
test ! -e src/lib/postgresCatalog.ts
test ! -e src/lib/postgresCatalog.test.ts
! rg -n "databaseQuery|postgres_database|CATALOG_|postgresCatalog|object_hooks" src --glob '!**/*.test.*'
```

Expected: all commands exit 0; the negated `rg` prints nothing.

- [ ] **Step 5: Run full verification**

```bash
cd postgres-interface
npm test -- --run
npm run lint
npm run format:check
npm run build
rg -n "postgres-action-approval-gate-v1" dist
! rg -n "postgres_database|CATALOG_UPSERT_QUERY|databaseQuery" dist
cd ..
git diff --check
git status --short
```

Expected: tests, lint, formatting, and build PASS; the build marker is present; removed catalog strings are absent; diff check is clean. `git status` may list only the files intentionally changed by this plan.

- [ ] **Step 6: Run PostgreSQL integration coverage when configured**

```bash
cd postgres-interface
npx vitest run src/lib/postgresIntegration.test.ts
```

Expected when the documented PostgreSQL integration environment is available: PASS. If the environment variables/container are absent, record the test as environment-blocked rather than claiming it ran.

- [ ] **Step 7: Commit Task 8**

```bash
git add \
  docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md \
  postgres-interface/README.md \
  postgres-interface/src/lib/postgresIntegration.test.ts \
  postgres-interface/src/lib/finalHardening.test.ts
git commit -m "docs: publish postgres resource connection authority"
```

- [ ] **Step 8: Review the implementation against the spec**

Read `docs/superpowers/specs/2026-09-19-postgres-resource-connection-authority-design.md` from top to bottom and verify every acceptance criterion against a passing test or command output. Do not publish or deploy without separate user authorization.
