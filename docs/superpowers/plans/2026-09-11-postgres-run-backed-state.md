# PostgreSQL Run-Backed State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every PostgreSQL-manager database dependency, derive lifecycle from the latest run, store administrator credentials in the owned resource, and support approved automatic installation before connection provisioning.

**Architecture:** Introduce strict run and resource boundary modules, then build database-free lifecycle actions and run-backed connection reconciliation on top of them. The React application consumes an explicit latest-run lifecycle model; durable recovery uses Deploy Commander runs, resources, and connections rather than SurrealDB records.

**Tech Stack:** React 19, TypeScript 5.9, Vitest 4, Testing Library, Deploy Commander installer-interface 0.3.5, Deploy Commander runner metadata.

**Spec:** `docs/superpowers/specs/2026-09-11-postgres-run-backed-state-design.md`

## Global Constraints

- Run statuses are queued `0`, running `1`, done `2`, and failed `3`.
- Lifecycle is derived only from the newest run's action and status; resource lookup is an operational consistency check.
- Supported actions are exactly `create`, `teardown`, `create-connection`, and `cleanup-connection`.
- The PostgreSQL service remains `postgres:15`, service/alias `postgres`, resource type/name `postgres`, and volume `postgres-data`.
- Administrator credentials live in owner-scoped resource metadata and required manager-scoped runner configurations only.
- Passwords never appear in notes, UI, logs, browser storage, public errors, or consumer connection metadata beyond that consumer's own logical password.
- Child auto-install requires explicit approval and confirmed install status `2` before provisioning starts.
- Existing resources without valid administrator metadata require teardown and reinstall.
- Deploy Commander serializes all operations for one manager; do not add an application-level lock.
- Production code must make no `databaseQuery` call.
- Use failing tests first and observe the expected failure before each production change.

## Target File Structure

- `src/lib/postgresRuns.ts`: validate/list exact runs, correlate starts, and resolve the latest-run lifecycle model.
- `src/lib/postgresResource.ts`: exhaustively find exact owned resources and validate full administrator/platform configuration.
- `src/lib/lifecycleActions.ts`: database-free install and teardown orchestration.
- `src/lib/connectionRuns.ts`: encode non-secret operation notes and parse recoverable provisioning/cleanup configurations.
- `src/lib/createPostgresConnection.ts`: orchestrate approval, optional installation, provisioning, persistence, and run-backed recovery.
- `src/App.tsx`: select dashboard/child mode and refresh run-backed presentation.
- `src/components/ManagerDashboard.tsx`: render explicit run-derived lifecycle and compatibility states.
- `src/components/ConnectionRequest.tsx`: own the approval UI and close the child with the workflow result.
- `src/components/PermissionDialog.tsx`: explain when approval includes PostgreSQL installation.
- Delete `src/lib/managerDatabase.ts`, `primaryState.ts`, `provisioningJournal.ts`, `recoverProvisioning.ts`, and `appRecovery.ts` after all consumers move.

---

### Task 1: Strict latest-run lifecycle contract

**Files:**
- Create: `postgres-interface/src/lib/postgresRuns.ts`
- Create: `postgres-interface/src/lib/postgresRuns.test.ts`

**Interfaces:**
- Consumes: `RPCCaller`, `RPC.RunItem`, and `RPC.GetRun` from the installer interface.
- Produces: `RunStatus`, `PostgresLifecycle`, `readLatestRun(caller)`, `readPostgresLifecycle(caller)`, `readExactRun(caller, runId)`, and `findCorrelatedRun(caller, action, note)`.

- [ ] **Step 1: Write the failing lifecycle-matrix test**

Create complete literal run fixtures and assert every supported branch:

```ts
const run = (action: string, status: number): RPC.RunItem => ({
  id: `${action}-${status}`,
  action,
  status,
  note: `note-${status}`,
  queued_at: '2026-09-11T00:00:00.000Z',
  created_at: '2026-09-11T00:00:00.000Z',
  updated_at: '2026-09-11T00:00:00.000Z',
  ...(status >= 1 ? { started_at: '2026-09-11T00:00:01.000Z' } : {}),
  ...(status >= 2 ? { finished_at: '2026-09-11T00:00:02.000Z' } : {}),
});

it.each([
  [null, { kind: 'not-installed' }],
  [run('create', 0), { kind: 'installing', runId: 'create-0' }],
  [run('create', 1), { kind: 'installing', runId: 'create-1' }],
  [run('create', 2), { kind: 'installed', runId: 'create-2', operationBusy: false }],
  [run('create', 3), { kind: 'installation-failed', runId: 'create-3' }],
  [run('teardown', 0), { kind: 'tearing-down', runId: 'teardown-0' }],
  [run('teardown', 1), { kind: 'tearing-down', runId: 'teardown-1' }],
  [run('teardown', 2), { kind: 'not-installed' }],
  [run('teardown', 3), { kind: 'teardown-failed', runId: 'teardown-3' }],
  [run('create-connection', 0), { kind: 'installed', runId: 'create-connection-0', operationBusy: true }],
  [run('create-connection', 1), { kind: 'installed', runId: 'create-connection-1', operationBusy: true }],
  [run('create-connection', 2), { kind: 'installed', runId: 'create-connection-2', operationBusy: false }],
  [run('create-connection', 3), { kind: 'installed', runId: 'create-connection-3', operationBusy: false }],
  [run('cleanup-connection', 0), { kind: 'installed', runId: 'cleanup-connection-0', operationBusy: true }],
  [run('cleanup-connection', 1), { kind: 'installed', runId: 'cleanup-connection-1', operationBusy: true }],
  [run('cleanup-connection', 2), { kind: 'installed', runId: 'cleanup-connection-2', operationBusy: false }],
  [run('cleanup-connection', 3), { kind: 'installed', runId: 'cleanup-connection-3', operationBusy: false }],
])('resolves %o from only the latest action and status', (latest, expected) => {
  expect(resolvePostgresLifecycle(latest)).toEqual(expected);
});
```

Add separate tests proving that unknown action/status throws
`PostgresRecoveryRequiredError`, and that `readLatestRun` invokes:

```ts
caller.getRuns(undefined, undefined, undefined, '-created_at', 1, 0)
```

with strict rejection of malformed pagination or malformed run fields.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/postgresRuns.test.ts
```

Expected: FAIL because `postgresRuns.ts` and `resolvePostgresLifecycle` do not exist.

- [ ] **Step 3: Implement the run types and resolver**

Use this public model:

```ts
export type RunStatus = 0 | 1 | 2 | 3;

export type PostgresLifecycle =
  | { kind: 'not-installed' }
  | { kind: 'installing'; runId: string }
  | { kind: 'installed'; runId: string; operationBusy: boolean }
  | { kind: 'installation-failed'; runId: string }
  | { kind: 'tearing-down'; runId: string }
  | { kind: 'teardown-failed'; runId: string };

export function resolvePostgresLifecycle(latest: RPC.RunItem | null): PostgresLifecycle;
export async function readLatestRun(caller: RPCCaller): Promise<RPC.RunItem | null>;
export async function readPostgresLifecycle(caller: RPCCaller): Promise<{
  latest: RPC.RunItem | null;
  lifecycle: PostgresLifecycle;
}>;
```

Validate all remote values as `unknown` before returning typed values. Require a
valid page with `limit === 1`, `offset === 0`, safe nonnegative `total`, and zero
or one complete run item. Normalize every invalid or unsupported response to
`PostgresRecoveryRequiredError`.

- [ ] **Step 4: Add exact-run and correlation tests, then observe RED**

Add tests which prove:

```ts
await expect(readExactRun(caller, 'run-1')).resolves.toEqual(validGetRun);
await expect(readExactRun(caller, 'other')).rejects.toBeInstanceOf(PostgresRecoveryRequiredError);
await expect(findCorrelatedRun(caller, 'create', 'postgres-install:op-1'))
  .resolves.toEqual({ kind: 'found', id: 'run-1' });
```

Use multi-page literal responses for zero, one, and two matching runs. Two
matches must return `{ kind: 'ambiguous' }`; malformed pages must reject rather
than look absent.

Run the focused test and confirm failures report missing exports.

- [ ] **Step 5: Implement exact-run validation and exhaustive correlation**

Export:

```ts
export type CorrelatedRun =
  | { kind: 'absent' }
  | { kind: 'ambiguous' }
  | { kind: 'found'; id: string };

export async function readExactRun(caller: RPCCaller, runId: string): Promise<RPC.GetRun>;
export async function findCorrelatedRun(
  caller: RPCCaller,
  action: string,
  note: string,
): Promise<CorrelatedRun>;
```

Keep the current exhaustive 50-item paging behavior from
`recoverProvisioning.ts`, but centralize it here. Validate that `getRun` returns
the requested ID, a supported status, a matching `config.run`, and a matching
`config.action` before returning it.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/postgresRuns.test.ts src/lib/runMonitor.test.ts
git add src/lib/postgresRuns.ts src/lib/postgresRuns.test.ts
git commit -m "feat: resolve postgres lifecycle from latest run"
```

Expected: all focused tests PASS.

---

### Task 2: Owner-scoped PostgreSQL resource contract

**Files:**
- Create: `postgres-interface/src/lib/postgresResource.ts`
- Create: `postgres-interface/src/lib/postgresResource.test.ts`
- Modify: `postgres-interface/src/lib/postgresContracts.ts`
- Modify: `postgres-interface/src/lib/installPlan.ts`
- Modify: `postgres-interface/src/lib/installPlan.test.ts`
- Modify: `postgres-interface/src/lib/postgresPlans.ts`
- Modify: `postgres-interface/src/lib/postgresPlans.test.ts`

**Interfaces:**
- Consumes: `AdminCredentials`, `PlatformConnection`, `RPCCaller`, and `RPC.ResourceItem`.
- Produces: `PostgresResourceMetadata`, `PostgresInstallation`, `listPostgresResources(caller)`, `readPostgresInstallation(caller, resource)`, and runner plans that accept `AdminCredentials` rather than `PrimaryState`.

- [ ] **Step 1: Write failing resource-contract tests**

Use the complete owner-scoped response shape:

```ts
const resource: RPC.ResourceItem = {
  id: 'resource-1', type: 'postgres', name: 'postgres', external: false,
  manager: 'postgres-manager', created_at: 'now', updated_at: 'now',
};
const details = {
  resource,
  config: {
    id: 'resource-1', manager: 'postgres-manager', agent: 'agent-1',
    name: 'postgres', resource_type: 'postgres',
    metadata: {
      engine: 'postgres', version: '15',
      administrator: {
        username: 'pg_admin_0123456789abcdef0123456789abcdef',
        password: 'admin-password',
      },
    },
    platform_connection: {
      type: 'Platform', data: { network: 'postgres-network' },
    },
  },
};
```

Assert that exhaustive resource paging returns only exact non-external
`postgres`/`postgres` resources, preserves two matches so callers can reject
ambiguity, and rejects malformed pagination. Assert that full configuration
returns this literal result:

```ts
{
  resource,
  credentials: {
    username: 'pg_admin_0123456789abcdef0123456789abcdef',
    password: 'admin-password',
  },
  platform: { type: 'Platform', data: { network: 'postgres-network' } },
}
```

Malformed owner, identity, administrator credentials, metadata, or platform
connection must reject with `PostgresRecoveryRequiredError`.

- [ ] **Step 2: Run the resource test and verify RED**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/postgresResource.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement strict resource discovery and parsing**

Create these types and functions:

```ts
export interface PostgresResourceMetadata {
  engine: 'postgres';
  version: '15';
  administrator: AdminCredentials;
}

export interface PostgresInstallation {
  resource: RPC.ResourceItem;
  credentials: AdminCredentials;
  platform: PlatformConnection;
}

export async function listPostgresResources(caller: RPCCaller): Promise<RPC.ResourceItem[]>;
export async function readPostgresInstallation(
  caller: RPCCaller,
  resource: RPC.ResourceItem,
): Promise<PostgresInstallation>;
```

Use 50-item exhaustive paging for `getMyResources('postgres', false, 50,
offset)`. Check the full `getResource(resource.id)` response against the summary,
including owner, IDs, external flag, resource type/name, and configuration
manager/type/name. Reuse `parsePlatformConnection` and the credential identifier
rules already exercised by `credentials.test.ts`.

- [ ] **Step 4: Change the install-plan test and verify RED**

Replace the old assertion that credentials are absent from resource metadata
with this behavior assertion:

```ts
expect(plan.services?.postgres?.resources?.[0]?.metadata).toEqual({
  engine: 'postgres',
  version: '15',
  administrator: credentials,
});
expect(JSON.stringify(plan.services?.postgres?.resources?.[0]?.metadata))
  .not.toContain('logical-password');
```

Run:

```bash
npx vitest run src/lib/installPlan.test.ts
```

Expected: FAIL because `administrator` is absent.

- [ ] **Step 5: Add administrator metadata and decouple admin runner plans from database state**

Change `RunnerService.resources[].metadata` from `Record<string, string>` to
`Record<string, unknown>`. Have `buildInstallPlan(credentials)` emit the exact
nested metadata above.

Change the admin plan API to:

```ts
export function buildProvisionPlan(
  administrator: AdminCredentials,
  logical: LogicalCredentials,
  platform: PlatformConnection,
): RunnerMetadata;

export function buildCleanupPlan(
  administrator: AdminCredentials,
  database: string,
  username: string,
  platform: PlatformConnection,
): RunnerMetadata;
```

Update `postgresPlans.test.ts` fixtures to pass `administrator` directly and
preserve the existing SQL, environment, platform, and redaction assertions.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/postgresResource.test.ts src/lib/installPlan.test.ts src/lib/postgresPlans.test.ts src/lib/credentials.test.ts
git add src/lib/postgresResource.ts src/lib/postgresResource.test.ts src/lib/postgresContracts.ts src/lib/installPlan.ts src/lib/installPlan.test.ts src/lib/postgresPlans.ts src/lib/postgresPlans.test.ts
git commit -m "feat: store postgres credentials in resource metadata"
```

Expected: all focused tests PASS and no test renders credential values.

---

### Task 3: Database-free installation and teardown actions

**Files:**
- Create: `postgres-interface/src/lib/lifecycleActions.ts`
- Create: `postgres-interface/src/lib/lifecycleActions.test.ts`
- Modify: `postgres-interface/src/lib/postgresErrors.ts`

**Interfaces:**
- Consumes: `readPostgresLifecycle`, `findCorrelatedRun`, `listPostgresResources`, `buildInstallPlan`, `waitForRun`, and `generateAdminCredentials`.
- Produces: `LifecycleActionDeps`, `installPostgres(deps)`, and `teardownPostgres(deps)` for later App and child-flow use.

- [ ] **Step 1: Write failing action-guard and ordering tests**

Define an RPC fake with complete run/resource pages and assert real workflow
outcomes. Required tests:

```ts
it('starts installation only when latest-run state and resources are absent', async () => {
  await installPostgres(deps);
  expect(start.mock.calls[0]).toEqual([
    'create',
    'ezenki/deploy-commander-runner:latest',
    expectedInstallPlan,
    expect.stringMatching(/^postgres-install:/),
  ]);
});

it('does not start installation when a resource contradicts retryable run state', async () => {
  await expect(installPostgres(depsWithResource)).rejects
    .toBeInstanceOf(PostgresRecoveryRequiredError);
  expect(start).not.toHaveBeenCalled();
});

it('starts teardown without reading administrator metadata', async () => {
  await teardownPostgres(depsWithInstalledRun);
  expect(getResource).not.toHaveBeenCalled();
  expect(start).toHaveBeenCalledWith(
    'teardown',
    'ezenki/deploy-commander-runner:latest',
    { remove_services: ['postgres'], remove_volumes: ['postgres-data'] },
    expect.stringMatching(/^postgres-teardown:/),
  );
});
```

Also cover installation retry after status `3`, teardown retry after status `3`,
active run rejection with `OperationBusyError`, aborts, and fixed non-secret
failure messages. Move `OperationBusyError` from `provisioningJournal.ts` to
`postgresErrors.ts` so lifecycle and connection workflows share an error type
that has no database dependency.

- [ ] **Step 2: Run the action test and verify RED**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/lifecycleActions.test.ts
```

Expected: FAIL because `lifecycleActions.ts` does not exist.

- [ ] **Step 3: Implement minimal database-free actions**

Use this dependency boundary:

```ts
export interface LifecycleActionDeps {
  caller: RPCCaller;
  events: RunEventSource;
  signal: AbortSignal;
  waitForRun?: typeof waitForRun;
  generateCredentials?: () => AdminCredentials;
}

export async function installPostgres(deps: LifecycleActionDeps): Promise<void>;
export async function teardownPostgres(deps: LifecycleActionDeps): Promise<void>;
```

Installation re-reads lifecycle and resources immediately before generating
credentials. Allow only `not-installed` and `installation-failed` with zero
resources. Teardown allows `installed` and `teardown-failed`; it also allows a
non-active contradictory state when at least one exact resource exists so the
dashboard can remove a legacy or partial installation. It never reads full
resource configuration or credentials.

Use one shared private helper which starts with a random note, accepts a nonblank
returned ID, and falls back to exact action/note correlation when `start`
throws or returns malformed data. Await the exact run with `waitForRun`. Preserve
`AbortError`; normalize status `3` to `PostgreSQL installation failed` or
`PostgreSQL teardown failed`, and other uncertainty to the existing recovery
errors.

- [ ] **Step 4: Add a start-ambiguity regression test and verify it fails before the helper exists**

Use `start.mockRejectedValue(new Error('transport secret'))` and an exhaustive
run page containing the exact note/action. Assert the workflow monitors that run
and does not leak the transport text. Add an ambiguous two-match case that
rejects recovery and starts no replacement run.

- [ ] **Step 5: Complete start-correlation handling and run focused tests**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/lifecycleActions.test.ts src/lib/postgresRuns.test.ts src/lib/runMonitor.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/lifecycleActions.ts src/lib/lifecycleActions.test.ts src/lib/postgresErrors.ts
git commit -m "feat: add database-free postgres lifecycle actions"
```

---

### Task 4: Versioned connection-run recovery records

**Files:**
- Create: `postgres-interface/src/lib/connectionRuns.ts`
- Create: `postgres-interface/src/lib/connectionRuns.test.ts`

**Interfaces:**
- Consumes: `RPC.GetRun`, `LogicalCredentials`, and generated identifier rules.
- Produces: `ConnectionOperationIdentity`, `ProvisionRunRecord`, `CleanupRunRecord`, `makeProvisionNote`, `makeCleanupNote`, `parseConnectionNote`, `parseProvisionRun`, and `parseCleanupRun`.

- [ ] **Step 1: Write failing note round-trip and secrecy tests**

Use IDs containing spaces, colons, percent signs, and Unicode so the test catches
delimiter bugs:

```ts
const identity = {
  operationId: '01234567-89ab-4def-8123-456789abcdef',
  callerId: 'consumer:manager % one',
  resourceId: 'resource:one/ä',
};

expect(parseConnectionNote(makeProvisionNote(identity))).toEqual({
  kind: 'provision',
  ...identity,
});
expect(parseConnectionNote(makeCleanupNote(identity))).toEqual({
  kind: 'cleanup',
  ...identity,
});
expect(makeProvisionNote(identity)).not.toContain('logical-password');
```

Reject wrong versions, malformed percent encoding, blank IDs, unsupported
prefixes, and invalid operation IDs.

- [ ] **Step 2: Run the note test and verify RED**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/connectionRuns.test.ts
```

Expected: FAIL because the note functions do not exist.

- [ ] **Step 3: Implement unambiguous versioned notes**

Use this exact grammar:

```text
postgres-provision:v1:<encoded-caller-id>:<encoded-resource-id>:<operation-id>
postgres-cleanup:v1:<encoded-caller-id>:<encoded-resource-id>:<operation-id>
```

Encode each variable component with `encodeURIComponent`; decode only after
requiring exactly five colon-separated fields. Restrict operation IDs to UUIDs
or 32 lowercase hexadecimal characters produced by the existing crypto fallback.

- [ ] **Step 4: Write failing run-configuration parsing tests**

Build complete `RPC.GetRun` fixtures whose `config.metadata` contains the actual
`postgres-admin` service environment. Assert:

```ts
expect(parseProvisionRun(provisionResult)).toEqual({
  identity,
  runId: 'provision-run',
  status: 2,
  logical: {
    database: 'db_0123456789abcdef0123456789abcdef',
    username: 'pg_user_0123456789abcdef0123456789abcdef',
    password: 'logical-password',
  },
});

expect(parseCleanupRun(cleanupResult)).toEqual({
  identity,
  runId: 'cleanup-run',
  status: 2,
  database: 'db_0123456789abcdef0123456789abcdef',
  username: 'pg_user_0123456789abcdef0123456789abcdef',
});
```

Reject mismatched action/config action/run IDs, missing service, wrong role,
malformed target identifiers, blank password, or a note/config identity mismatch.

- [ ] **Step 5: Implement strict provision and cleanup parsers**

Export:

```ts
export interface ConnectionOperationIdentity {
  operationId: string;
  callerId: string;
  resourceId: string;
}

export interface ProvisionRunRecord {
  identity: ConnectionOperationIdentity;
  runId: string;
  status: RunStatus;
  logical: LogicalCredentials;
}

export interface CleanupRunRecord {
  identity: ConnectionOperationIdentity;
  runId: string;
  status: RunStatus;
  database: string;
  username: string;
}
```

Validate the real runner configuration boundary rather than accepting a
test-only recovery payload. Do not return administrator credentials from these
parsers.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/connectionRuns.test.ts src/lib/postgresPlans.test.ts
git add src/lib/connectionRuns.ts src/lib/connectionRuns.test.ts
git commit -m "feat: encode recovery in postgres connection runs"
```

Expected: all focused tests PASS.

---

### Task 5: Run-backed connection orchestration

**Files:**
- Modify: `postgres-interface/src/lib/createPostgresConnection.ts`
- Modify: `postgres-interface/src/lib/createPostgresConnection.test.ts`
- Modify: `postgres-interface/src/lib/postgresConnectionContract.ts`
- Modify: `postgres-interface/src/lib/postgresConnectionContract.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4, `findExistingConnection`, permission preferences, `createConnection`, and `waitForRun`.
- Produces: database-free `createPostgresConnection(deps, request)` and `reconcileLatestConnectionRun(deps, requestedCallerId?)`.

- [ ] **Step 1: Replace database fixtures with a failing successful-orchestration test**

Change the public request so callers no longer supply trusted resource/platform
or private state:

```ts
export interface ConnectionRequest {
  currentManagerId: string;
  callingManagerId: string;
}

export interface PermissionContext {
  installsPostgres: boolean;
}

export interface ConnectionWorkflowDeps {
  caller: RPCCaller;
  events: RunEventSource;
  storage: Storage;
  requestPermission: (context: PermissionContext) => Promise<PermissionDecision>;
  generateAdminCredentials?: () => AdminCredentials;
  generateCredentials: () => LogicalCredentials;
  waitForRun: typeof waitForRun;
  signal: AbortSignal;
}
```

For an existing valid resource, assert observable behavior: the real workflow
returns the normalized created connection, the start payload contains the
resource-derived administrator/platform configuration, and `databaseQuery` is
not present on the fake at all. The note must parse back to the trusted caller
and resource.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/createPostgresConnection.test.ts
```

Expected: FAIL because the workflow still requires `PrimaryState` and calls the
database journal.

- [ ] **Step 3: Implement the straight-through database-free path**

Implement this order for a valid resource:

```text
list one exact resource
read and validate full resource installation
find and return an existing valid caller/resource connection
reconcile the latest prior connection run
check remembered approval or request approval with installsPostgres=false
generate logical credentials
start create-connection with a versioned note
wait for exact status 2
re-read the resource configuration
repeat duplicate lookup
create and normalize the Deploy Commander connection
```

Preserve cancellation and fixed non-secret errors. Treat storage failures as
not remembered; a failed `setItem` does not fail an otherwise approved request.

- [ ] **Step 4: Write failing terminal recovery tests**

Add literal scenarios for the latest `create-connection` run:

- Status `0/1`: wait for the exact run and never call `start` for another
  provisioning run.
- Status `2` plus matching connection: return it to the matching requested
  caller; reconcile without returning it to another caller.
- Status `2` without a connection: create the connection from validated run
  configuration.
- Ambiguous `createConnection` failure plus an authoritative matching lookup:
  return the found connection.
- Status `3`: start exact cleanup and never persist the failed provision.

Assert final RPC-visible results, connection records, and run counts rather than
the existence of helper mocks.

- [ ] **Step 5: Implement provisioning recovery and persistence reconciliation**

Export:

```ts
export type ConnectionRecoveryResult =
  | { kind: 'retry' }
  | { kind: 'connection'; value: RPC.CreateConnection };

export async function reconcileLatestConnectionRun(
  deps: ConnectionWorkflowDeps,
  latest: RPC.RunItem | null,
  requestedCallerId?: string,
): Promise<ConnectionRecoveryResult | null>;
```

For queued/running runs, use `waitForRun` and then re-read the exact configuration
with `readExactRun`. On successful provisioning, load the exact resource from
the note, validate current administrator/platform configuration, and reconcile
the recorded caller's connection. Before creating a missing record, repeat
duplicate lookup. After ambiguous persistence, repeat lookup again; start
cleanup only when absence is conclusive. Every cleanup start gets a fresh random
operation ID in its note while retaining the recorded caller/resource IDs and
the exact database/username in runner configuration. This keeps action/note
correlation unique even after a failed cleanup is retried.

- [ ] **Step 6: Write failing cleanup recovery tests**

Cover latest `cleanup-connection` status `0`, `1`, `2`, and `3`:

```ts
expect(start).not.toHaveBeenCalled(); // queued/running cleanup is awaited
expect(result).toEqual({ kind: 'retry' }); // successful cleanup
expect(start).toHaveBeenCalledWith(
  'cleanup-connection',
  'ezenki/deploy-commander-runner:latest',
  expectedCleanupPlan,
  expect.stringMatching(/^postgres-cleanup:v1:/),
); // failed cleanup gets one deliberate retry
```

Also prove that cleanup uses current resource administrator credentials and the
failed run's validated database/username, not historical administrator values.

- [ ] **Step 7: Implement idempotent cleanup recovery**

Build cleanup plans with current resource configuration. If a cleanup retry
fails, return the fixed recovery error without recursively launching more runs.
After confirmed cleanup success, return `{ kind: 'retry' }` so the current
request may generate fresh logical credentials. A later invocation that retries
failed cleanup creates another fresh cleanup operation ID; it never reuses a
note already attached to a terminal run.

- [ ] **Step 8: Run focused tests and commit**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/createPostgresConnection.test.ts src/lib/connectionRuns.test.ts src/lib/postgresConnectionContract.test.ts src/lib/postgresPlans.test.ts
git add src/lib/createPostgresConnection.ts src/lib/createPostgresConnection.test.ts src/lib/postgresConnectionContract.ts src/lib/postgresConnectionContract.test.ts
git commit -m "feat: recover postgres connections from runs"
```

Expected: all focused tests PASS with no database fake.

---

### Task 6: Approved automatic installation in the child workflow

**Files:**
- Modify: `postgres-interface/src/lib/createPostgresConnection.ts`
- Modify: `postgres-interface/src/lib/createPostgresConnection.test.ts`
- Modify: `postgres-interface/src/components/ConnectionRequest.tsx`
- Modify: `postgres-interface/src/components/ConnectionRequest.test.tsx`
- Modify: `postgres-interface/src/components/PermissionDialog.tsx`
- Modify: `postgres-interface/src/components/PermissionDialog.test.tsx`

**Interfaces:**
- Consumes: database-free lifecycle/resource/connection workflows from Tasks 1-5.
- Produces: one child flow which can install first and then provision, plus approval copy that distinguishes auto-install.

- [ ] **Step 1: Write the failing install-before-provision workflow test**

Use one real `createPostgresConnection` call with an RPC fake whose resource page
is empty before installation and contains a complete resource afterward. Record
observable operations in an array and assert the literal order:

```ts
expect(operations).toEqual([
  'permission:install',
  'start:create',
  'wait:install-run',
  'resource:resource-1',
  'remember:resource-1',
  'start:create-connection',
  'wait:provision-run',
  'persist:consumer-manager:resource-1',
]);
```

Add a status `3` install case asserting `start:create-connection` and persistence
never occur. Add cancellation asserting neither run starts. Add a contradictory
run/resource state asserting `503` recovery rather than installation.

- [ ] **Step 2: Run the focused workflow test and verify RED**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/createPostgresConnection.test.ts
```

Expected: FAIL because the workflow rejects an absent resource.

- [ ] **Step 3: Implement approved sequential auto-install**

When there is no resource:

```ts
const decision = await deps.requestPermission({ installsPostgres: true });
if (!decision.allowed) throw new Error('Database access was cancelled');
await installPostgres({
  caller: deps.caller,
  events: deps.events,
  signal: deps.signal,
  waitForRun: deps.waitForRun,
  generateCredentials: deps.generateAdminCredentials,
});
const resources = await listPostgresResources(deps.caller);
if (resources.length !== 1) throw new PostgresRecoveryRequiredError();
const installation = await readPostgresInstallation(deps.caller, resources[0]);
if (decision.remember) {
  rememberPermission(deps.storage, request.currentManagerId, installation.resource.id);
}
```

Only after that block may the workflow generate logical credentials and start
`create-connection`. Do not prompt twice in the same invocation.

- [ ] **Step 4: Write failing approval-dialog behavior tests**

Render the real dialogs for both contexts. For `installsPostgres={true}`, assert
the accessible description says the request will install PostgreSQL and create a
logical database. For `false`, preserve the existing connection-only text. Click
Allow with the checkbox and assert the component callback receives `{ allowed:
true, remember: true }` through `ConnectionRequest`'s promise adapter.

- [ ] **Step 5: Update the child components**

Change `PermissionDialogProps` to include:

```ts
installsPostgres?: boolean;
```

Change `ConnectionRequestProps` to remove `resource`, `primary`,
`initialError`, and `initialResult`. Its required production inputs become:

```ts
caller: RPCCaller;
events: RunEventSource;
wire: Wire;
currentManagerId: string;
callingManagerId: string | null;
storage?: Storage;
```

The component passes the requested permission context into the dialog, keeps one
workflow per mount, aborts monitoring on unmount, and closes the wire exactly
once. Keep status mapping `400/409/499/503/500` and secret normalization.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/createPostgresConnection.test.ts src/components/ConnectionRequest.test.tsx src/components/PermissionDialog.test.tsx
git add src/lib/createPostgresConnection.ts src/lib/createPostgresConnection.test.ts src/components/ConnectionRequest.tsx src/components/ConnectionRequest.test.tsx src/components/PermissionDialog.tsx src/components/PermissionDialog.test.tsx
git commit -m "feat: install postgres for approved connection requests"
```

Expected: all focused tests PASS.

---

### Task 7: Run-backed dashboard and application boot

**Files:**
- Modify: `postgres-interface/src/App.tsx`
- Modify: `postgres-interface/src/App.test.tsx`
- Modify: `postgres-interface/src/components/ManagerDashboard.tsx`
- Modify: `postgres-interface/src/components/ManagerDashboard.test.tsx`

**Interfaces:**
- Consumes: `PostgresLifecycle`, resource validators, `lifecycleActions`, and the simplified `ConnectionRequest`.
- Produces: dashboard presentation based on latest run plus explicit resource compatibility/contradiction flags.

- [ ] **Step 1: Write failing dashboard rendering tests for the lifecycle model**

Replace `PrimaryState` fixtures with literal `PostgresLifecycle` props. Required
observable cases:

```ts
renderDashboard({ lifecycle: { kind: 'installing', runId: 'run-1' } });
expect(screen.getByRole('status')).toHaveTextContent('Installing PostgreSQL');

renderDashboard({
  lifecycle: { kind: 'installed', runId: 'run-2', operationBusy: false },
  resource,
  resourceCompatible: true,
});
expect(screen.getByRole('heading', { name: 'PostgreSQL is installed' })).toBeVisible();

renderDashboard({ lifecycle: { kind: 'installation-failed', runId: 'run-3' } });
expect(screen.getByRole('button', { name: 'Install PostgreSQL' })).toBeVisible();

renderDashboard({
  lifecycle: { kind: 'teardown-failed', runId: 'run-4' },
  resource,
});
expect(screen.getByRole('button', { name: 'Retry teardown' })).toBeVisible();
```

Also cover busy connection runs, multiple resources, run/resource contradiction,
and incompatible credential-less resources with teardown available.

- [ ] **Step 2: Run the dashboard test and verify RED**

Run:

```bash
cd postgres-interface
npx vitest run src/components/ManagerDashboard.test.tsx
```

Expected: FAIL because the component still derives readiness from `PrimaryState`.

- [ ] **Step 3: Refactor ManagerDashboard to explicit lifecycle props**

Use this boundary:

```ts
export interface ManagerDashboardProps {
  lifecycle: PostgresLifecycle;
  resource: RPC.ResourceItem | null;
  resourceCompatible: boolean;
  resourceAmbiguous: boolean;
  resourceContradiction: boolean;
  activeAction: LifecycleAction;
  error: string | null;
  permissionRemembered: boolean;
  onInstall: () => void;
  onTeardown: () => void;
  onRetry: () => void;
  onResetPermission: () => void;
}
```

Run-derived queued/running lifecycle renders progress even after a reload.
`installed.operationBusy` disables lifecycle actions and shows the existing busy
message without changing installed identity. Compatibility or contradiction
warnings take precedence over the normal installed card and always offer
teardown where safe.

- [ ] **Step 4: Write failing App boot and event-refresh tests**

Build app-client fixtures without `databaseQuery`. Assert:

- Root boot calls `getRuns(..., '-created_at', 1, 0)` and renders the matrix.
- A database method that throws, if included only as a sentinel, is never called.
- Connection mode renders the child even when no resource exists.
- A terminal `run-update` event causes a new latest-run read and updates the
  visible lifecycle.
- Unmount ends one stable wire and aborts current monitoring.
- Multiple/malformed resources and invalid latest runs render fixed non-secret
  attention states.

- [ ] **Step 5: Run the App test and verify RED**

Run:

```bash
cd postgres-interface
npx vitest run src/App.test.tsx
```

Expected: FAIL because App initializes manager storage and reads private state.

- [ ] **Step 6: Refactor App boot, events, and actions**

Root dashboard boot performs:

```text
getManager
getMetadata
readPostgresLifecycle
listPostgresResources
readPostgresInstallation when exactly one resource exists
derive compatibility and contradiction flags
```

Child boot performs only manager/caller validation before rendering
`ConnectionRequest`; the workflow owns resource discovery and recovery.

Create one interface client for the component lifetime. Its event callback
increments a refresh generation for run-start/run-update events without creating
a second wire. Dashboard install/teardown buttons call Task 3 workflows and then
refresh. Clear remembered permission only for the currently loaded resource.

- [ ] **Step 7: Run focused React and workflow tests**

Run:

```bash
cd postgres-interface
npx vitest run src/App.test.tsx src/components/ManagerDashboard.test.tsx src/components/ConnectionRequest.test.tsx src/lib/lifecycleActions.test.ts src/lib/createPostgresConnection.test.ts
```

Expected: all focused tests PASS with no React act warnings.

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/components/ManagerDashboard.tsx src/components/ManagerDashboard.test.tsx
git commit -m "feat: drive postgres dashboard from latest run"
```

---

### Task 8: Remove the database architecture and update current documentation

**Files:**
- Delete: `postgres-interface/src/lib/managerDatabase.ts`
- Delete: `postgres-interface/src/lib/managerDatabase.test.ts`
- Delete: `postgres-interface/src/lib/managerDatabaseIntegration.test.ts`
- Delete: `postgres-interface/src/lib/primaryState.ts`
- Delete: `postgres-interface/src/lib/primaryState.test.ts`
- Delete: `postgres-interface/src/lib/provisioningJournal.ts`
- Delete: `postgres-interface/src/lib/provisioningJournal.test.ts`
- Delete: `postgres-interface/src/lib/recoverProvisioning.ts`
- Delete: `postgres-interface/src/lib/recoverProvisioning.test.ts`
- Delete: `postgres-interface/src/lib/appRecovery.ts`
- Delete: `postgres-interface/src/test/databaseQuery.ts`
- Delete or replace: `postgres-interface/src/lib/installationLifecycle.ts`
- Delete or replace: `postgres-interface/src/lib/installationLifecycle.test.ts`
- Modify: `postgres-interface/README.md`
- Modify: `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md`
- Modify: `postgres-interface/AGENTS.md`
- Modify: `postgres-interface/src/AGENTS.md`
- Modify: `postgres-interface/src/components/AGENTS.md`

**Interfaces:**
- Consumes: all database-free modules and passing tests from Tasks 1-7.
- Produces: a codebase with no database lifecycle/recovery path and current documentation matching the new contract.

- [ ] **Step 1: Add a final behavior regression before deleting old modules**

In `App.test.tsx`, retain a sentinel `databaseQuery` function which throws
`new Error('database must not be used')`. Render both root and child modes through
successful user-visible outcomes and assert they reach the installed dashboard
and connection result. This test must fail before Task 7's boot refactor and pass
now; do not assert on the sentinel mock itself.

Run:

```bash
cd postgres-interface
npx vitest run src/App.test.tsx
```

Expected: PASS because real behavior no longer depends on the sentinel.

- [ ] **Step 2: Remove obsolete modules and imports**

Delete the database-backed modules/tests listed above. If
`installationLifecycle.ts` only re-exports Task 3 functions, remove it and update
imports to `lifecycleActions.ts`; otherwise delete its database-backed recovery
contents and retain only a deliberate public re-export. Remove every
`PrimaryState`, `OperationRecord`, `initializeManagerDatabase`,
`recoverInstallationOnBoot`, `recoverTeardownOnBoot`, and
`recoverConnectionOnBoot` import.

Do not delete historical files under `docs/superpowers`; the approved 2026-09-11
spec supersedes their historical designs.

- [ ] **Step 3: Run the complete test suite and repair only deletion fallout**

Run:

```bash
cd postgres-interface
npm test
```

Expected: PASS. Any failure must be fixed by removing a stale database fixture or
import, not by restoring database behavior.

- [ ] **Step 4: Update current operator and consumer documentation**

Update `postgres-interface/README.md` to state:

- Latest action/status is lifecycle truth.
- Administrator credentials live in owner-scoped resource metadata.
- Connection recovery uses versioned run notes/configuration and Deploy
  Commander connection records.
- Connection requests can request approval, install, then provision.
- Credential-less existing resources require teardown/reinstall.
- Remove the manager-database integration-check section.

Update `POSTGRES_MANAGER_INTERFACE_GUIDE.md` prerequisites, approval behavior,
failure/retry text, and ownership section to include automatic installation and
remove the statement that the resource must already exist. Keep the returned
connection metadata contract unchanged.

Update scoped `AGENTS.md` guidance so future changes do not reintroduce
database-backed lifecycle state or stale `PrimaryState`/journal instructions.

- [ ] **Step 5: Verify no production database path remains**

Run:

```bash
cd postgres-interface
rg -n "databaseQuery|postgres_state|postgres_operation|initializeManagerDatabase|PrimaryState|OperationRecord" src --glob '!*.test.ts' --glob '!test/**'
```

Expected: no output.

Then run:

```bash
rg -n "SurrealDB|manager database|postgres_state|postgres_operation" README.md ../docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md
```

Expected: no stale PostgreSQL-manager database claims in current documentation.

- [ ] **Step 6: Commit**

```bash
git add -A src README.md AGENTS.md ../docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md
git commit -m "refactor: remove postgres manager database state"
```

---

### Task 9: Full verification and review

**Files:**
- Modify only files required by failures or review findings.

**Interfaces:**
- Consumes: the complete implementation.
- Produces: evidence that tests, static checks, build, security boundaries, and approved behavior all pass.

- [ ] **Step 1: Run focused security and recovery suites**

Run:

```bash
cd postgres-interface
npx vitest run src/lib/postgresRuns.test.ts src/lib/postgresResource.test.ts src/lib/lifecycleActions.test.ts src/lib/connectionRuns.test.ts src/lib/createPostgresConnection.test.ts src/components/ConnectionRequest.test.tsx src/App.test.tsx
```

Expected: PASS with no unhandled rejection, leaked secret, or React warning.

- [ ] **Step 2: Run all project checks**

Run each command separately:

```bash
cd postgres-interface
npm test
npm run lint
npm run build
```

Expected: every command exits `0` with no warnings requiring code changes.

- [ ] **Step 3: Inspect the final diff and database-removal boundary**

Run:

```bash
git diff --check 6600b58..HEAD
git status --short
rg -n "databaseQuery|postgres_state|postgres_operation|initializeManagerDatabase|PrimaryState|OperationRecord" postgres-interface/src --glob '!*.test.ts' --glob '!test/**'
```

Expected: clean diff checks, only intentional working-tree changes, and no
production database-state matches.

- [ ] **Step 4: Request code review**

Invoke `superpowers:requesting-code-review`. Ask the reviewer to compare the
implementation against
`docs/superpowers/specs/2026-09-11-postgres-run-backed-state-design.md`, with
special attention to latest-run ordering, cross-caller recovery, secret
boundaries, install-before-provision ordering, and removal of all database calls.

- [ ] **Step 5: Apply verified review fixes with TDD**

For each valid finding, first add or adjust the smallest failing behavioral test,
run it to observe the expected failure, make the minimal production change, and
rerun the focused and full checks. Use `superpowers:receiving-code-review` before
changing code in response to review feedback.

- [ ] **Step 6: Run verification-before-completion and commit final fixes**

Invoke `superpowers:verification-before-completion`, rerun:

```bash
cd postgres-interface
npm test
npm run lint
npm run build
```

If review produced changes, commit them with:

```bash
git add -A
git commit -m "fix: complete run-backed postgres state"
```

If review produced no changes, do not create an empty commit.
