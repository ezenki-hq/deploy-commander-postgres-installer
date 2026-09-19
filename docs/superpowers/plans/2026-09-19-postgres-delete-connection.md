# PostgreSQL Delete Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a caller-facing `delete-connection` action that lets a manager delete only its own validated PostgreSQL connections, cleans up the generated PostgreSQL role and any connection-created database, and then removes the Deploy Commander connection record.

**Architecture:** Route exact delete requests to a dedicated child workflow. Keep request parsing, authoritative connection snapshots, run reconciliation, workflow orchestration, and React presentation in separate focused modules; reuse the existing `cleanup-connection` runner plan and strict run parsers. Retain the connection record until cleanup succeeds so retries can recover from durable run history without adding a journal or browser state.

**Tech Stack:** React 19, TypeScript 5.9, Vitest 4, Testing Library, `@ezenki/deploy-commander-installer-interface` 0.5, Deploy Commander runner metadata, PostgreSQL 15 shell/psql integration tests.

**Spec:** `docs/superpowers/specs/2026-09-19-postgres-delete-connection-design.md`

## Global Constraints

- The public request action is exactly `delete-connection`; the internal runner action remains `cleanup-connection`.
- Request metadata accepts only `action` and optional nonblank `connection`; caller and resource identity never come from editable metadata.
- Ownership is checked against the trusted `getCallingManager()` value and the authoritative PostgreSQL resource before selection, before cleanup, and before record deletion.
- A created database is dropped only for `scope: "database", operation: "create"`; existing-database and full-access cleanup remove only the generated role.
- The Deploy Commander connection record is not deleted until PostgreSQL cleanup has confirmed success.
- Recovery uses validated runs and connection records only; do not add manager-database state, browser persistence, or an operation journal.
- UI and close responses never expose passwords, administrator credentials, raw RPC errors, SQL output, or Docker details.
- Use `@ezenki/deploy-commander-installer-interface` RPC methods; do not add direct HTTP calls.
- Preserve create-connection and installation lifecycle behavior.

## Review Focus

- A supplied ID owned by another manager must be indistinguishable from a missing ID: both close with the same fixed `404`; covered in Tasks 2 and 4.
- The connection may change after approval or after cleanup: both revalidation boundaries must prevent deletion of a changed record; covered in Tasks 4 and 5.
- Paginated connection/run results may duplicate IDs, change totals, or ignore server-side filters: reject them as recovery-required; covered in Tasks 2 and 3.
- A `404` is success only after this workflow has established cleanup success; an initial `404` is never success; covered in Task 5.
- Secrets may occur in connection metadata and thrown transport errors: rendered UI and `wire.close` must remain fixed and non-secret; covered in Tasks 6 and 7.

---

### Task 1: Parse the Delete Request Contract

**Files:**

- Create: `postgres-interface/src/lib/postgresDeleteRequest.ts`
- Create: `postgres-interface/src/lib/postgresDeleteRequest.test.ts`

**Interfaces:**

- Produces: `ParsedDeleteConnectionRequest = { connectionId: string | null }`.
- Produces: `parseDeleteConnectionRequest(value: unknown): ParsedDeleteConnectionRequest`.

- [ ] **Step 1: Write the failing parser tests**

Create `postgresDeleteRequest.test.ts` with exact accepted forms and fail-closed cases:

```ts
import { describe, expect, it } from 'vitest';
import { parseDeleteConnectionRequest } from './postgresDeleteRequest';

describe('parseDeleteConnectionRequest', () => {
  it('accepts selection mode', () => {
    expect(parseDeleteConnectionRequest({ action: 'delete-connection' })).toEqual({
      connectionId: null,
    });
  });

  it('accepts one supplied connection id', () => {
    expect(
      parseDeleteConnectionRequest({
        action: 'delete-connection',
        connection: 'connection-1',
      }),
    ).toEqual({ connectionId: 'connection-1' });
  });

  it.each([
    null,
    [],
    {},
    { action: 'create-connection' },
    { action: 'delete-connection', connection: '' },
    { action: 'delete-connection', connection: '   ' },
    { action: 'delete-connection', connection: 42 },
    { action: 'delete-connection', manager: 'forged-manager' },
    { action: 'delete-connection', connection: 'connection-1', extra: true },
  ])('rejects malformed request %#', (value) => {
    expect(() => parseDeleteConnectionRequest(value)).toThrow(
      'Invalid PostgreSQL connection deletion request',
    );
  });

  it('requires action to be an own property', () => {
    const value = Object.create({ action: 'delete-connection' }) as Record<string, unknown>;
    expect(() => parseDeleteConnectionRequest(value)).toThrow();
  });
});
```

- [ ] **Step 2: Run the parser test and verify RED**

Run:

```bash
cd postgres-interface
npm test -- src/lib/postgresDeleteRequest.test.ts
```

Expected: FAIL because `postgresDeleteRequest.ts` does not exist.

- [ ] **Step 3: Implement the exact parser**

Create `postgresDeleteRequest.ts`:

```ts
import { PostgresRequestError } from './postgresErrors';

export interface ParsedDeleteConnectionRequest {
  connectionId: string | null;
}

const own = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const invalid = (): never => {
  throw new PostgresRequestError(400, 'Invalid PostgreSQL connection deletion request');
};

export function parseDeleteConnectionRequest(value: unknown): ParsedDeleteConnectionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  const request = value as Record<string, unknown>;
  if (!own(request, 'action') || request.action !== 'delete-connection') return invalid();
  if (Object.keys(request).some((key) => key !== 'action' && key !== 'connection')) {
    return invalid();
  }
  if (!own(request, 'connection')) return { connectionId: null };
  if (typeof request.connection !== 'string' || request.connection.trim().length === 0) {
    return invalid();
  }
  return { connectionId: request.connection };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- src/lib/postgresDeleteRequest.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the request contract**

```bash
git add postgres-interface/src/lib/postgresDeleteRequest.ts postgres-interface/src/lib/postgresDeleteRequest.test.ts
git commit -m "feat: parse postgres connection deletion requests"
```

### Task 2: Expose Strict Owned-Connection Snapshots

**Files:**

- Modify: `postgres-interface/src/lib/postgresConnectionContract.ts`
- Modify: `postgres-interface/src/lib/postgresConnectionContract.test.ts`

**Interfaces:**

- Consumes: `AccessRequest`, `PlatformConnection`, `RPCCaller`, and existing strict pagination/normalization helpers.
- Produces: `PostgresConnectionTarget` containing `id`, trusted manager/resource, `external: false`, access, generated login, normalized labels, and authoritative platform.
- Produces: `listOwnedPostgresConnections(caller, managerId, resourceId, platform): Promise<PostgresConnectionTarget[]>`.
- Produces: `readOwnedPostgresConnection(caller, connectionId, managerId, resourceId, platform): Promise<PostgresConnectionTarget | null>`; only a structured RPC `404` becomes `null`.
- Produces: `samePostgresConnectionTarget(left, right): boolean` for both revalidation boundaries.

- [ ] **Step 1: Add failing discovery, ownership, platform, and snapshot tests**

Extend `postgresConnectionContract.test.ts` using its existing `summary`, `full`, and `platform` fixtures:

```ts
import {
  findExistingConnection,
  listOwnedPostgresConnections,
  normalizePostgresConnection,
  readOwnedPostgresConnection,
  samePostgresConnectionTarget,
} from './postgresConnectionContract';

const access = { scope: 'database', operation: 'create', database: 'orders' } as const;
const labels = {
  team: 'payments',
  'postgres.access': 'database',
  'postgres.database': 'orders',
};
const modern = () =>
  full({ ...logicalMetadata, database: 'orders', access, platform_connection: platform });

it('lists every fully validated connection owned by the requested manager', async () => {
  const second = { ...summary, id: 'connection-2', labels };
  const caller = {
    getConnections: vi
      .fn()
      .mockResolvedValueOnce({ items: [{ ...summary, labels }], limit: 1, offset: 0, total: 2 })
      .mockResolvedValueOnce({ items: [second], limit: 1, offset: 1, total: 2 }),
    getConnection: vi.fn(async (id: string) => ({
      ...modern(),
      connection: { ...modern().connection, id },
      config: { ...modern().config, id },
    })),
  } as unknown as RPCCaller;

  await expect(
    listOwnedPostgresConnections(caller, 'manager-2', 'resource-1', platform),
  ).resolves.toMatchObject([
    { id: 'connection-1', access },
    { id: 'connection-2', access },
  ]);
  expect(caller.getConnections).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ manager: 'manager-2', resource: 'resource-1', offset: 0 }),
  );
});

it.each([
  ['other manager', { ...summary, manager: 'other-manager', labels }],
  ['other resource', { ...summary, resource: 'other-resource', labels }],
  ['external', { ...summary, external: true, labels }],
])('rejects %s summaries instead of exposing them', async (_name, item) => {
  const caller = {
    getConnections: vi.fn().mockResolvedValue({ items: [item], limit: 50, offset: 0, total: 1 }),
  } as unknown as RPCCaller;
  await expect(
    listOwnedPostgresConnections(caller, 'manager-2', 'resource-1', platform),
  ).rejects.toThrow(PostgresRecoveryRequiredError);
});

it('requires stored platform metadata to match the authoritative platform for deletion', async () => {
  const caller = {
    getConnections: vi.fn().mockResolvedValue({
      items: [{ ...summary, labels }],
      limit: 50,
      offset: 0,
      total: 1,
    }),
    getConnection: vi.fn().mockResolvedValue(
      full({
        ...logicalMetadata,
        database: 'orders',
        access,
        platform_connection: { type: 'Platform', data: { network: 'stale-network' } },
      }),
    ),
  } as unknown as RPCCaller;
  await expect(
    listOwnedPostgresConnections(caller, 'manager-2', 'resource-1', platform),
  ).rejects.toThrow(PostgresRecoveryRequiredError);
});

it('returns null only for an explicit not-found re-read', async () => {
  const caller = {
    getConnection: vi.fn().mockRejectedValue({ status: 404, message: 'secret backend detail' }),
  } as unknown as RPCCaller;
  await expect(
    readOwnedPostgresConnection(caller, 'connection-1', 'manager-2', 'resource-1', platform),
  ).resolves.toBeNull();
});

it('compares every destructive snapshot field but ignores timestamps', async () => {
  const caller = { getConnection: vi.fn().mockResolvedValue(modern()) } as unknown as RPCCaller;
  const target = await readOwnedPostgresConnection(
    caller,
    'connection-1',
    'manager-2',
    'resource-1',
    platform,
  );
  expect(target).not.toBeNull();
  expect(samePostgresConnectionTarget(target!, { ...target!, password: 'changed' })).toBe(false);
  expect(samePostgresConnectionTarget(target!, structuredClone(target!))).toBe(true);
});
```

Also add table cases for duplicate summary IDs, total changes between pages, missing `access`, malformed reserved labels, and a non-404 `getConnection` rejection normalized to `PostgreSQL connection lookup failed`.

- [ ] **Step 2: Run the contract test and verify RED**

Run: `npm test -- src/lib/postgresConnectionContract.test.ts`

Expected: FAIL because the three deletion-oriented exports do not exist.

- [ ] **Step 3: Add strict deletion normalization and snapshots**

Extend the internal normalization options and require an exact stored platform only for deletion paths:

```ts
interface NormalizeOptions {
  requireAccess?: boolean;
  requirePlatformMatch?: boolean;
}

function samePlatform(left: PlatformConnection, right: PlatformConnection): boolean {
  return left.type === right.type && left.data.network === right.data.network;
}
```

Inside `normalizeConnection`, parse `metadata.platform_connection` before replacing it with the authoritative value. If `requirePlatformMatch` is true, require the property to exist and `samePlatform(stored, authoritativePlatform)`.

Add the public target and conversion helpers:

```ts
export interface PostgresConnectionTarget {
  id: string;
  managerId: string;
  resourceId: string;
  external: false;
  access: AccessRequest;
  username: string;
  password: string;
  labels: Record<string, string>;
  platform: PlatformConnection;
}

function targetOf(value: RPC.CreateConnection): PostgresConnectionTarget {
  const metadata = value.config.metadata as unknown as UnknownRecord;
  if (
    !validAccess(metadata.access) ||
    typeof metadata.username !== 'string' ||
    typeof metadata.password !== 'string'
  )
    throw invalidConnection();
  return {
    id: value.connection.id,
    managerId: value.connection.manager,
    resourceId: value.connection.resource,
    external: false,
    access: structuredClone(metadata.access),
    username: metadata.username,
    password: metadata.password,
    labels: parseLabels(value.connection.labels),
    platform: parseAuthoritativePlatform(metadata.platform_connection),
  };
}
```

Export list, exact re-read, and equality helpers:

```ts
export async function listOwnedPostgresConnections(
  caller: RPCCaller,
  managerId: string,
  resourceId: string,
  platform: PlatformConnection,
): Promise<PostgresConnectionTarget[]> {
  const expected = normalizeExpected({ managerId, resourceId });
  const summaries = await listConnectionSummaries(caller, expected);
  return Promise.all(
    summaries.map(async (summary) =>
      targetOf(
        await readConnection(caller, summary, expected, platform, {
          requireAccess: true,
          requirePlatformMatch: true,
        }),
      ),
    ),
  );
}

function rpcStatus(value: unknown): number | null {
  return isRecord(value) && typeof value.status === 'number' ? value.status : null;
}

export async function readOwnedPostgresConnection(
  caller: RPCCaller,
  connectionId: string,
  managerId: string,
  resourceId: string,
  platform: PlatformConnection,
): Promise<PostgresConnectionTarget | null> {
  let value: unknown;
  try {
    value = await caller.getConnection(connectionId, { include_labels: true });
  } catch (error) {
    if (rpcStatus(error) === 404) return null;
    throw new Error('PostgreSQL connection lookup failed');
  }
  return targetOf(
    normalizeConnection(value, { managerId, resourceId, connectionId }, platform, {
      requireAccess: true,
      requirePlatformMatch: true,
    }),
  );
}

export function samePostgresConnectionTarget(
  left: PostgresConnectionTarget,
  right: PostgresConnectionTarget,
): boolean {
  return (
    left.id === right.id &&
    left.managerId === right.managerId &&
    left.resourceId === right.resourceId &&
    left.external === right.external &&
    left.username === right.username &&
    left.password === right.password &&
    accessEqual(left.access, right.access) &&
    sameLabels(left.labels, right.labels) &&
    samePlatform(left.platform, right.platform)
  );
}
```

- [ ] **Step 4: Run focused contract tests and verify GREEN**

Run: `npm test -- src/lib/postgresConnectionContract.test.ts`

Expected: PASS, including unchanged legacy normalization tests.

- [ ] **Step 5: Commit authoritative deletion targets**

```bash
git add postgres-interface/src/lib/postgresConnectionContract.ts postgres-interface/src/lib/postgresConnectionContract.test.ts
git commit -m "feat: resolve owned postgres connection targets"
```

### Task 3: Add Exhaustive Cleanup-Run Discovery

**Files:**

- Modify: `postgres-interface/src/lib/postgresRuns.ts`
- Modify: `postgres-interface/src/lib/postgresRuns.test.ts`
- Modify: `postgres-interface/src/lib/connectionRuns.ts`
- Modify: `postgres-interface/src/lib/connectionRuns.test.ts`

**Interfaces:**

- Produces: `listRunsByAction(caller, action): Promise<RPC.RunItem[]>` with strict pagination and filter verification.
- Extends: `CleanupRunRecord` with `platform?: PlatformConnection`; every v2 cleanup has the parsed platform, while v1 compatibility remains optional.

- [ ] **Step 1: Write failing strict history tests**

Extend `postgresRuns.test.ts`:

```ts
import {
  findCorrelatedRun,
  listRunsByAction,
  readExactRun,
  readLatestRun,
  resolvePostgresLifecycle,
} from './postgresRuns';

it('lists one action across stable pages', async () => {
  const first = Array.from({ length: 50 }, (_, index) =>
    run('cleanup-connection', 2, `cleanup-${index}`),
  );
  const getRuns = vi
    .fn()
    .mockResolvedValueOnce({ items: first, limit: 50, offset: 0, total: 51 })
    .mockResolvedValueOnce({
      items: [run('cleanup-connection', 1, 'cleanup-50')],
      limit: 50,
      offset: 50,
      total: 51,
    });
  await expect(listRunsByAction(c({ getRuns }), 'cleanup-connection')).resolves.toHaveLength(51);
  expect(getRuns).toHaveBeenNthCalledWith(1, {
    action: 'cleanup-connection',
    sort: '-created_at',
    limit: 50,
    offset: 0,
  });
});

it.each([
  { items: [run('create', 2)], limit: 50, offset: 0, total: 1 },
  {
    items: [run('cleanup-connection', 2, 'duplicate'), run('cleanup-connection', 2, 'duplicate')],
    limit: 50,
    offset: 0,
    total: 2,
  },
])('rejects ignored filters or duplicate run ids %#', async (response) => {
  await expect(
    listRunsByAction(c({ getRuns: vi.fn().mockResolvedValue(response) }), 'cleanup-connection'),
  ).rejects.toThrow(PostgresRecoveryRequiredError);
});
```

Add a two-page changed-total case and a malformed page case. Extend `connectionRuns.test.ts` so every v2 cleanup assertion includes `platform`, while the v1 cleanup assertion confirms `platform` is absent.

- [ ] **Step 2: Run run-contract tests and verify RED**

Run:

```bash
npm test -- src/lib/postgresRuns.test.ts src/lib/connectionRuns.test.ts
```

Expected: FAIL because `listRunsByAction` and cleanup-record platform output do not exist.

- [ ] **Step 3: Implement strict action history and retain parsed cleanup platform**

Add to `postgresRuns.ts`:

```ts
export async function listRunsByAction(
  caller: RPCCaller,
  action: 'cleanup-connection',
): Promise<RPC.RunItem[]> {
  const runs: RPC.RunItem[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | null = null;
  for (let offset = 0; ; offset += PAGE_LIMIT) {
    let response: unknown;
    try {
      response = await caller.getRuns({ action, sort: '-created_at', limit: PAGE_LIMIT, offset });
    } catch {
      throw fail();
    }
    const items = page(response, offset, PAGE_LIMIT);
    const total = (response as { total: number }).total;
    if (expectedTotal === null) expectedTotal = total;
    if (total !== expectedTotal) throw fail();
    for (const item of items) {
      if (item.action !== action || seen.has(item.id)) throw fail();
      seen.add(item.id);
      runs.push(item);
    }
    if (offset + items.length >= total) break;
  }
  return runs;
}
```

In `connectionRuns.ts`, add `platform?: PlatformConnection` to `CleanupRunRecord`. In the v2 branch of `parseCleanupRun`, assign:

```ts
const platform = validatePlatform(service.connections[0]);
```

and include `platform` in the returned cleanup record. Keep v1 cleanup output unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- src/lib/postgresRuns.test.ts src/lib/connectionRuns.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit cleanup-run discovery**

```bash
git add postgres-interface/src/lib/postgresRuns.ts postgres-interface/src/lib/postgresRuns.test.ts postgres-interface/src/lib/connectionRuns.ts postgres-interface/src/lib/connectionRuns.test.ts
git commit -m "feat: discover postgres cleanup run history"
```

### Task 4: Implement Confirmed Deletion and Cleanup Ordering

**Files:**

- Create: `postgres-interface/src/lib/deletePostgresConnection.ts`
- Create: `postgres-interface/src/lib/deletePostgresConnection.test.ts`

**Interfaces:**

- Consumes: `ParsedDeleteConnectionRequest`, `PostgresConnectionTarget`, `buildCleanupPlan`, `makeCleanupNote`, `findCorrelatedRun`, `waitForRun`, installation resource helpers.
- Produces: safe `DeleteConnectionChoice = { id: string; access: AccessRequest }`.
- Produces: `DeleteConnectionApprovalContext` and `DeleteConnectionDecision`.
- Produces: `deletePostgresConnection(deps, request): Promise<{ connection: string }>`.

- [ ] **Step 1: Write failing ownership, selection, cancellation, and ordering tests**

Create fixtures for one installed resource and four target access modes. Use an injected deterministic operation ID and `waitForRun` stub. The core tests must include this concrete shape:

```ts
const platform: PlatformConnection = {
  type: 'Platform',
  data: { network: 'postgres-network' },
};
const resource: RPC.ResourceItem = {
  id: 'resource-1',
  type: 'postgres',
  name: 'postgres',
  manager: 'postgres-manager',
  external: false,
  agent: 'agent-1',
  created_at: 'now',
  updated_at: 'now',
};
const administrator = {
  username: 'dc_admin_0123456789abcdef0123456789abcdef',
  password: 'admin-password',
};
const login = {
  username: 'dc_user_0123456789abcdef0123456789abcdef',
  password: 'logical-password',
};
function resourceDetails() {
  return {
    resource,
    config: {
      id: resource.id,
      manager: resource.manager,
      agent: resource.agent,
      resource_type: 'postgres',
      name: 'postgres',
      metadata: { engine: 'postgres', version: '15', administrator },
      platform_connection: platform,
    },
  };
}
function connectionFixture(access: AccessRequest, overrides: { password?: string } = {}) {
  const database = access.scope === 'database' ? access.database : 'postgres';
  const labels =
    access.scope === 'database'
      ? { 'postgres.access': 'database', 'postgres.database': database }
      : { 'postgres.access': 'full' };
  return {
    connection: {
      id: 'connection-1',
      manager: 'consumer-manager',
      resource: resource.id,
      external: false,
      created_at: 'now',
      updated_at: 'now',
      labels,
    },
    config: {
      id: 'connection-1',
      manager: 'consumer-manager',
      resource: resource.id,
      metadata: {
        host: 'postgres',
        port: 5432,
        database,
        username: login.username,
        password: overrides.password ?? login.password,
        access,
        platform_connection: platform,
      },
    },
  };
}

const createdDatabaseAccess = {
  scope: 'database' as const,
  operation: 'create' as const,
  database: 'orders',
};

function deletionCaller(access: AccessRequest = createdDatabaseAccess) {
  const target = connectionFixture(access);
  return {
    getMyResources: vi.fn().mockResolvedValue({
      items: [resource],
      limit: 50,
      offset: 0,
      total: 1,
    }),
    getResource: vi.fn().mockResolvedValue(resourceDetails()),
    getConnections: vi.fn().mockResolvedValue({
      items: [target.connection],
      limit: 50,
      offset: 0,
      total: 1,
    }),
    getConnection: vi.fn().mockResolvedValue(target),
    getRuns: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    start: vi.fn().mockResolvedValue({ id: 'cleanup-run', status: 0, queued_at: 'now' }),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
  } as unknown as RPCCaller & Record<string, ReturnType<typeof vi.fn>>;
}

function cleanupRun(id: string, status: 0 | 1 | 2 | 3, access = createdDatabaseAccess) {
  const metadata = buildCleanupPlan({
    administrator,
    login,
    access,
    resourceId: resource.id,
    platform,
  });
  return {
    run: {
      id,
      action: 'cleanup-connection',
      status,
      note: makeCleanupNote({
        operationId: '01234567-89ab-4def-8123-456789abcdef',
        callerId: 'consumer-manager',
        resourceId: resource.id,
      }),
      queued_at: 'now',
      created_at: 'now',
      updated_at: 'now',
    },
    config: {
      id,
      run: id,
      action: 'cleanup-connection',
      manager: 'postgres-manager',
      runner: 'ezenki/deploy-commander-runner:latest',
      metadata,
    },
  } as RPC.GetRun;
}

function runDeletion(
  caller: RPCCaller,
  metadata: ParsedDeleteConnectionRequest,
  approval = requestApproval,
) {
  return deletePostgresConnection(
    {
      caller,
      events: createRunEventSource(),
      requestApproval: approval,
      waitForRun: vi.fn(async (_caller, _events, runId) => cleanupRun(runId, 2)),
      generateOperationId: () => '01234567-89ab-4def-8123-456789abcdef',
      signal: new AbortController().signal,
    },
    {
      currentManagerId: 'postgres-manager',
      callingManagerId: 'consumer-manager',
      metadata,
    },
  );
}

const requestApproval = vi.fn().mockResolvedValue({
  allowed: true,
  connectionId: 'connection-1',
});
const caller = deletionCaller({ access: createdDatabaseAccess });
const result = await deletePostgresConnection(
  {
    caller,
    events: createRunEventSource(),
    requestApproval,
    waitForRun: vi.fn(async (_caller, _events, runId) => cleanupRun(runId, 2)),
    generateOperationId: () => '01234567-89ab-4def-8123-456789abcdef',
    signal: new AbortController().signal,
  },
  {
    currentManagerId: 'postgres-manager',
    callingManagerId: 'consumer-manager',
    metadata: { connectionId: null },
  },
);

expect(requestApproval).toHaveBeenCalledWith({
  callingManagerId: 'consumer-manager',
  requestedConnectionId: null,
  choices: [{ id: 'connection-1', access: createdDatabaseAccess }],
});
expect(caller.start).toHaveBeenCalledWith(
  expect.objectContaining({
    action: 'cleanup-connection',
    runner: 'ezenki/deploy-commander-runner:latest',
  }),
);
expect(caller.deleteConnection).toHaveBeenCalledWith('connection-1');
expect(caller.deleteConnection.mock.invocationCallOrder[0]).toBeGreaterThan(
  caller.start.mock.invocationCallOrder[0],
);
expect(result).toEqual({ connection: 'connection-1' });
```

Add access-mode, ownership, and cancellation tests:

```ts
it.each([
  { scope: 'database', operation: 'create', database: 'orders' },
  { scope: 'database', operation: 'existing', database: 'warehouse' },
  { scope: 'full', superuser: false },
  { scope: 'full', superuser: true },
] as const)('passes exact access mode to cleanup plan %j', async (access) => {
  const caller = deletionCaller(access);
  await runDeletion(caller, { connectionId: 'connection-1' });
  const options = caller.start.mock.calls[0][0] as StartRunOptions;
  const service = (options.metadata as RunnerMetadata).services?.['postgres-admin'];
  const expectedMode =
    access.scope === 'database'
      ? `${access.operation}-database`
      : `full-${access.superuser ? 'superuser' : 'constrained'}`;
  expect(service?.environment?.ACCESS_MODE).toBe(expectedMode);
  expect(service?.command?.[2]).toMatch(
    access.scope === 'database' && access.operation === 'create' ? /DROP DATABASE/ : /DROP ROLE/,
  );
  if (!(access.scope === 'database' && access.operation === 'create')) {
    expect(service?.command?.[2]).not.toMatch(/DROP DATABASE/);
  }
});

it('returns the same 404 for a missing or differently owned supplied id', async () => {
  const caller = deletionCaller();
  caller.getConnections.mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 });
  await expect(runDeletion(caller, { connectionId: 'connection-other' })).rejects.toMatchObject({
    status: 404,
  });
  expect(requestApproval).not.toHaveBeenCalled();
  expect(caller.start).not.toHaveBeenCalled();
});

it('cancels without starting cleanup or deleting the record', async () => {
  const caller = deletionCaller();
  requestApproval.mockResolvedValue({ allowed: false });
  await expect(runDeletion(caller, { connectionId: null })).rejects.toMatchObject({ status: 499 });
  expect(caller.start).not.toHaveBeenCalled();
  expect(caller.deleteConnection).not.toHaveBeenCalled();
});

it.each([
  { items: [], limit: 50, offset: 0, total: 0 },
  { items: [resource, { ...resource, id: 'resource-2' }], limit: 50, offset: 0, total: 2 },
] as const)('fails closed for installation response %#', async (resources) => {
  const caller = deletionCaller();
  caller.getMyResources.mockResolvedValue(resources);
  await expect(runDeletion(caller, { connectionId: null })).rejects.toThrow(
    PostgresRecoveryRequiredError,
  );
});

it('rejects an approval id that was not offered', async () => {
  const caller = deletionCaller();
  requestApproval.mockResolvedValue({ allowed: true, connectionId: 'connection-forged' });
  await expect(runDeletion(caller, { connectionId: null })).rejects.toMatchObject({ status: 400 });
  expect(caller.start).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the workflow test and verify RED**

Run: `npm test -- src/lib/deletePostgresConnection.test.ts`

Expected: FAIL because the workflow module does not exist.

- [ ] **Step 3: Implement request validation, approval, cleanup start, and record deletion**

Create `deletePostgresConnection.ts` with these public interfaces:

```ts
export interface DeleteConnectionChoice {
  id: string;
  access: AccessRequest;
}
export interface DeleteConnectionApprovalContext {
  callingManagerId: string;
  requestedConnectionId: string | null;
  choices: DeleteConnectionChoice[];
}
export type DeleteConnectionDecision = { allowed: false } | { allowed: true; connectionId: string };
export interface DeleteConnectionRequest {
  currentManagerId: string;
  callingManagerId: string;
  metadata: ParsedDeleteConnectionRequest;
}
export interface DeleteConnectionWorkflowDeps {
  caller: RPCCaller;
  events: RunEventSource;
  requestApproval: (context: DeleteConnectionApprovalContext) => Promise<DeleteConnectionDecision>;
  waitForRun: typeof waitForRun;
  generateOperationId?: () => string;
  signal: AbortSignal;
}
export interface DeleteConnectionResult {
  connection: string;
}
```

Implement these private helpers with fixed errors: `aborted`, `resources`, `choiceOf`, `rpcStatus`, `startCleanup`, and `revalidate`. Use `listPostgresResources` plus `readPostgresInstallation` and require exactly one installation.

The main function must follow this ordering:

```ts
export async function deletePostgresConnection(
  deps: DeleteConnectionWorkflowDeps,
  request: DeleteConnectionRequest,
): Promise<DeleteConnectionResult> {
  aborted(deps.signal);
  if (!nonBlank(request.currentManagerId) || !nonBlank(request.callingManagerId)) {
    throw new PostgresRequestError(400, 'A calling manager is required');
  }
  const installation = await resources(deps.caller);
  const owned = await listOwnedPostgresConnections(
    deps.caller,
    request.callingManagerId,
    installation.resource.id,
    installation.platform,
  );
  const candidates =
    request.metadata.connectionId === null
      ? owned
      : owned.filter((target) => target.id === request.metadata.connectionId);
  if (candidates.length === 0) {
    throw new PostgresRequestError(404, 'PostgreSQL connection was not found');
  }
  const decision = await deps.requestApproval({
    callingManagerId: request.callingManagerId,
    requestedConnectionId: request.metadata.connectionId,
    choices: candidates.map(choiceOf),
  });
  if (!decision || decision.allowed !== true) {
    throw new PostgresRequestError(499, 'PostgreSQL connection deletion was cancelled');
  }
  const approved = candidates.find((target) => target.id === decision.connectionId);
  if (!approved) {
    throw new PostgresRequestError(400, 'Invalid PostgreSQL connection deletion approval');
  }
  const beforeCleanup = await readOwnedPostgresConnection(
    deps.caller,
    approved.id,
    request.callingManagerId,
    installation.resource.id,
    installation.platform,
  );
  if (!beforeCleanup || !samePostgresConnectionTarget(approved, beforeCleanup)) {
    throw new PostgresRequestError(409, 'PostgreSQL connection changed during deletion');
  }
  await reconcileOrRunCleanup(deps, installation, approved);
  const beforeDelete = await readOwnedPostgresConnection(
    deps.caller,
    approved.id,
    request.callingManagerId,
    installation.resource.id,
    installation.platform,
  );
  if (beforeDelete && !samePostgresConnectionTarget(approved, beforeDelete)) {
    throw new PostgresRequestError(409, 'PostgreSQL connection changed during deletion');
  }
  if (beforeDelete) {
    try {
      await deps.caller.deleteConnection(approved.id);
    } catch (error) {
      if (rpcStatus(error) !== 404) throw new Error('Unable to delete the PostgreSQL connection');
    }
  }
  return { connection: approved.id };
}
```

For this task, implement `reconcileOrRunCleanup` as the fresh-run path below; Task 5 replaces it with historical reconciliation. Intentionally omit `catalogOperationId` so explicit deletion uses the direct managed-catalog delete hook.

```ts
async function reconcileOrRunCleanup(
  deps: DeleteConnectionWorkflowDeps,
  installation: PostgresInstallation,
  target: PostgresConnectionTarget,
): Promise<void> {
  const identity = {
    operationId: (deps.generateOperationId ?? operationId)(),
    callerId: target.managerId,
    resourceId: target.resourceId,
  };
  const metadata = buildCleanupPlan({
    administrator: installation.credentials,
    login: { username: target.username, password: target.password },
    access: target.access,
    resourceId: target.resourceId,
    platform: target.platform,
  });
  const runId = await startCleanup(deps, metadata, makeCleanupNote(identity));
  await waitAndValidateCleanup(deps, runId, target);
}
```

- [ ] **Step 4: Run the workflow test and verify GREEN**

Run: `npm test -- src/lib/deletePostgresConnection.test.ts`

Expected: PASS for fresh deletion, access-mode selection, cancellation, ownership, and ordering.

- [ ] **Step 5: Commit the initial deletion workflow**

```bash
git add postgres-interface/src/lib/deletePostgresConnection.ts postgres-interface/src/lib/deletePostgresConnection.test.ts
git commit -m "feat: delete owned postgres connections"
```

### Task 5: Complete Durable Retry, Conflict, and Concurrency Recovery

**Files:**

- Modify: `postgres-interface/src/lib/deletePostgresConnection.ts`
- Modify: `postgres-interface/src/lib/deletePostgresConnection.test.ts`

**Interfaces:**

- Consumes: `listRunsByAction`, `readExactRun`, `parseCleanupRun`, `findCorrelatedRun`, and `PostgresConnectionTarget`.
- Completes: `reconcileOrRunCleanup` for durable queued/running/success/failed/ambiguous outcomes.

- [ ] **Step 1: Add failing recovery matrix tests**

Add table-driven cases to `deletePostgresConnection.test.ts`:

```ts
it.each([
  [0, 'waits for queued cleanup'],
  [1, 'waits for running cleanup'],
  [2, 'reuses successful cleanup'],
  [3, 'surfaces failed cleanup'],
] as const)('%s: %s', async (status) => {
  const existing = cleanupRun('cleanup-existing', status);
  caller.getRuns.mockResolvedValue({
    items: [existing.run],
    limit: 50,
    offset: 0,
    total: 1,
  });
  caller.getRun.mockResolvedValue(existing);
  if (status === 3) {
    await expect(run()).rejects.toThrow('PostgreSQL connection cleanup failed');
    expect(caller.deleteConnection).not.toHaveBeenCalled();
  } else {
    await expect(run()).resolves.toEqual({ connection: 'connection-1' });
    expect(caller.start).not.toHaveBeenCalled();
  }
});
```

Add explicit recovery and race tests with the shared Task 4 fixtures:

```ts
it('ignores unrelated cleanup runs', async () => {
  const caller = deletionCaller();
  const unrelated = cleanupRun('unrelated', 2);
  unrelated.run.note = makeCleanupNote({
    operationId: '11234567-89ab-4def-8123-456789abcdef',
    callerId: 'other-manager',
    resourceId: resource.id,
  });
  caller.getRuns.mockResolvedValue({ items: [unrelated.run], limit: 50, offset: 0, total: 1 });
  caller.getRun.mockResolvedValue(unrelated);
  await runDeletion(caller, { connectionId: 'connection-1' });
  expect(caller.start).toHaveBeenCalledOnce();
});

it.each(['password', 'access', 'platform'] as const)(
  'returns conflict when the same cleanup username has changed %s',
  async (field) => {
    const caller = deletionCaller();
    const conflicting = cleanupRun('conflicting', 1);
    mutateCleanupField(conflicting, field);
    caller.getRuns.mockResolvedValue({
      items: [conflicting.run],
      limit: 50,
      offset: 0,
      total: 1,
    });
    caller.getRun.mockResolvedValue(conflicting);
    await expect(runDeletion(caller, { connectionId: 'connection-1' })).rejects.toMatchObject({
      status: 409,
    });
    expect(caller.start).not.toHaveBeenCalled();
  },
);

it('requires recovery for duplicate exact cleanup runs', async () => {
  const caller = deletionCaller();
  const first = cleanupRun('cleanup-1', 2);
  const second = cleanupRun('cleanup-2', 2);
  caller.getRuns.mockResolvedValue({
    items: [first.run, second.run],
    limit: 50,
    offset: 0,
    total: 2,
  });
  caller.getRun.mockImplementation(async (id: string) => (id === 'cleanup-1' ? first : second));
  await expect(runDeletion(caller, { connectionId: 'connection-1' })).rejects.toThrow(
    PostgresRecoveryRequiredError,
  );
});

it('reconciles a lost start response by immutable note', async () => {
  const caller = deletionCaller();
  caller.start.mockRejectedValue(new Error('lost response'));
  caller.getRuns
    .mockResolvedValueOnce({ items: [], limit: 50, offset: 0, total: 0 })
    .mockResolvedValueOnce({
      items: [cleanupRun('accepted-run', 1).run],
      limit: 50,
      offset: 0,
      total: 1,
    });
  await expect(runDeletion(caller, { connectionId: 'connection-1' })).resolves.toEqual({
    connection: 'connection-1',
  });
});

it.each([
  [2, true],
  [3, false],
  [1, false],
] as const)('reconciles failed monitoring at exact status %s', async (status, succeeds) => {
  const caller = deletionCaller();
  const exact = cleanupRun('cleanup-run', status);
  const execution = deletionExecution(caller, {
    waitForRun: vi.fn().mockRejectedValue(new RunFailedError('cleanup-run', 3)),
  });
  caller.getRun.mockResolvedValue(exact);
  if (succeeds) await expect(execution).resolves.toEqual({ connection: 'connection-1' });
  else await expect(execution).rejects.toBeInstanceOf(Error);
  expect(caller.deleteConnection).toHaveBeenCalledTimes(succeeds ? 1 : 0);
});

it('reuses successful cleanup after record deletion failed', async () => {
  const caller = deletionCaller();
  caller.deleteConnection.mockRejectedValueOnce(new Error('private transport detail'));
  await expect(runDeletion(caller, { connectionId: 'connection-1' })).rejects.toThrow(
    'Unable to delete the PostgreSQL connection',
  );
  caller.getRuns.mockResolvedValue({
    items: [cleanupRun('cleanup-run', 2).run],
    limit: 50,
    offset: 0,
    total: 1,
  });
  caller.getRun.mockResolvedValue(cleanupRun('cleanup-run', 2));
  caller.deleteConnection.mockResolvedValue(undefined);
  await expect(runDeletion(caller, { connectionId: 'connection-1' })).resolves.toEqual({
    connection: 'connection-1',
  });
  expect(caller.start).toHaveBeenCalledTimes(1);
});

it.each(['missing-final-read', 'delete-404'] as const)(
  'treats %s as success only after cleanup',
  async (mode) => {
    const caller = deletionCaller();
    if (mode === 'missing-final-read') {
      const target = connectionFixture(createdDatabaseAccess);
      caller.getConnection
        .mockReset()
        .mockResolvedValueOnce(target)
        .mockResolvedValueOnce(target)
        .mockRejectedValueOnce({ status: 404 });
    } else {
      caller.deleteConnection.mockRejectedValue({ status: 404 });
    }
    await expect(runDeletion(caller, { connectionId: 'connection-1' })).resolves.toEqual({
      connection: 'connection-1',
    });
  },
);

it.each(['before-cleanup', 'before-delete'] as const)(
  'rejects snapshot changes %s',
  async (point) => {
    const caller = deletionCaller();
    const changed = connectionFixture(createdDatabaseAccess, { password: 'changed-secret' });
    caller.getConnection.mockReset();
    caller.getConnection.mockResolvedValueOnce(connectionFixture(createdDatabaseAccess));
    if (point === 'before-cleanup') caller.getConnection.mockResolvedValueOnce(changed);
    else
      caller.getConnection
        .mockResolvedValueOnce(connectionFixture(createdDatabaseAccess))
        .mockResolvedValueOnce(changed);
    await expect(runDeletion(caller, { connectionId: 'connection-1' })).rejects.toMatchObject({
      status: 409,
    });
    expect(caller.deleteConnection).not.toHaveBeenCalled();
    if (point === 'before-cleanup') expect(caller.start).not.toHaveBeenCalled();
  },
);

it('aborts local monitoring without deleting the record', async () => {
  const caller = deletionCaller();
  const controller = new AbortController();
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const execution = deletionExecution(caller, {
    signal: controller.signal,
    waitForRun: vi.fn().mockRejectedValue(abort),
  });
  controller.abort();
  await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
  expect(caller.deleteConnection).not.toHaveBeenCalled();
});
```

Use these helpers for the table cases:

```ts
function mutateCleanupField(value: RPC.GetRun, field: 'password' | 'access' | 'platform'): void {
  const service = (value.config.metadata as RunnerMetadata).services?.['postgres-admin'];
  if (!service?.environment || !service.connections) throw new Error('invalid test fixture');
  if (field === 'password') service.environment.TARGET_PASSWORD = 'changed-secret';
  if (field === 'access') {
    value.config.metadata = buildCleanupPlan({
      administrator,
      login,
      access: { scope: 'database', operation: 'existing', database: 'orders' },
      resourceId: resource.id,
      platform,
    });
  }
  if (field === 'platform') {
    value.config.metadata = buildCleanupPlan({
      administrator,
      login,
      access: createdDatabaseAccess,
      resourceId: resource.id,
      platform: { type: 'Platform', data: { network: 'changed-network' } },
    });
  }
}

function deletionExecution(caller: RPCCaller, overrides: Partial<DeleteConnectionWorkflowDeps>) {
  return deletePostgresConnection(
    {
      caller,
      events: createRunEventSource(),
      requestApproval,
      waitForRun: vi.fn(async (_caller, _events, runId) => cleanupRun(runId, 2)),
      generateOperationId: () => '01234567-89ab-4def-8123-456789abcdef',
      signal: new AbortController().signal,
      ...overrides,
    },
    {
      currentManagerId: 'postgres-manager',
      callingManagerId: 'consumer-manager',
      metadata: { connectionId: 'connection-1' },
    },
  );
}
```

- [ ] **Step 2: Run recovery tests and verify RED**

Run: `npm test -- src/lib/deletePostgresConnection.test.ts -t "queued|running|successful|failed|ambiguous|changed|retry|404|abort"`

Expected: FAIL where the initial workflow always starts a new cleanup run.

- [ ] **Step 3: Implement target-aware cleanup-run reconciliation**

Add exact comparison helpers:

```ts
function accessEqual(left: AccessRequest, right: AccessRequest): boolean {
  if (left.scope !== right.scope) return false;
  if (left.scope === 'database' && right.scope === 'database') {
    return left.operation === right.operation && left.database === right.database;
  }
  return left.scope === 'full' && right.scope === 'full' && left.superuser === right.superuser;
}

function cleanupMatchesTarget(record: CleanupRunRecord, target: PostgresConnectionTarget): boolean {
  return (
    record.version === 'v2' &&
    record.platform !== undefined &&
    record.identity.callerId === target.managerId &&
    record.identity.resourceId === target.resourceId &&
    record.login.username === target.username &&
    record.login.password === target.password &&
    accessEqual(record.access, target.access) &&
    record.platform.type === target.platform.type &&
    record.platform.data.network === target.platform.data.network
  );
}
```

Implement strict discovery and start/wait reconciliation:

```ts
async function matchingCleanupRuns(
  caller: RPCCaller,
  target: PostgresConnectionTarget,
): Promise<CleanupRunRecord[]> {
  const matches: CleanupRunRecord[] = [];
  for (const summary of await listRunsByAction(caller, 'cleanup-connection')) {
    let note: ConnectionNote;
    try {
      note = parseConnectionNote(summary.note);
    } catch {
      throw new PostgresRecoveryRequiredError();
    }
    if (note.kind !== 'cleanup') throw new PostgresRecoveryRequiredError();
    if (note.callerId !== target.managerId || note.resourceId !== target.resourceId) continue;
    const record = parseCleanupRun(await readExactRun(caller, summary.id));
    if (record.login.username !== target.username) continue;
    if (!cleanupMatchesTarget(record, target)) {
      throw new PostgresRequestError(409, 'PostgreSQL connection changed during deletion');
    }
    matches.push(record);
  }
  return matches;
}

async function startCleanup(
  deps: DeleteConnectionWorkflowDeps,
  metadata: RunnerMetadata,
  note: string,
): Promise<string> {
  let runId: string | null = null;
  try {
    const started = await deps.caller.start({
      action: 'cleanup-connection',
      runner: 'ezenki/deploy-commander-runner:latest',
      metadata,
      note,
    });
    if (typeof started.id === 'string' && started.id.trim().length > 0) runId = started.id;
  } catch {
    // Reconcile the immutable note below.
  }
  if (runId) return runId;
  const correlated = await findCorrelatedRun(deps.caller, 'cleanup-connection', note);
  if (correlated.kind === 'ambiguous') throw new PostgresRecoveryRequiredError();
  if (correlated.kind === 'absent')
    throw new Error('Unable to start PostgreSQL connection cleanup');
  return correlated.id;
}

async function waitAndValidateCleanup(
  deps: DeleteConnectionWorkflowDeps,
  runId: string,
  target: PostgresConnectionTarget,
): Promise<void> {
  let exact: RPC.GetRun;
  try {
    exact = await deps.waitForRun(deps.caller, deps.events, runId, { signal: deps.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    exact = await readExactRun(deps.caller, runId);
  }
  const cleanup = parseCleanupRun(exact);
  if (!cleanupMatchesTarget(cleanup, target)) throw new PostgresRecoveryRequiredError();
  if (cleanup.status === 3) throw new Error('PostgreSQL connection cleanup failed');
  if (cleanup.status !== 2) throw new PostgresRecoveryRequiredError();
}
```

Implement reconciliation:

```ts
async function reconcileOrRunCleanup(
  deps: DeleteConnectionWorkflowDeps,
  installation: PostgresInstallation,
  target: PostgresConnectionTarget,
): Promise<void> {
  const matches = await matchingCleanupRuns(deps.caller, target);
  if (matches.length > 1) throw new PostgresRecoveryRequiredError();
  if (matches.length === 1) {
    const match = matches[0];
    if (match.status === 3) throw new Error('PostgreSQL connection cleanup failed');
    if (match.status < 2) await waitAndValidateCleanup(deps, match.runId, target);
    return;
  }
  const identity = {
    operationId: (deps.generateOperationId ?? operationId)(),
    callerId: target.managerId,
    resourceId: target.resourceId,
  };
  const metadata = buildCleanupPlan({
    administrator: installation.credentials,
    login: { username: target.username, password: target.password },
    access: target.access,
    resourceId: target.resourceId,
    platform: target.platform,
  });
  const runId = await startCleanup(deps, metadata, makeCleanupNote(identity));
  await waitAndValidateCleanup(deps, runId, target);
}
```

- [ ] **Step 4: Run all deletion workflow tests and verify GREEN**

Run: `npm test -- src/lib/deletePostgresConnection.test.ts`

Expected: PASS.

- [ ] **Step 5: Run neighboring run/plan tests**

Run:

```bash
npm test -- src/lib/postgresPlans.test.ts src/lib/postgresAccessPlans.test.ts src/lib/postgresRuns.test.ts src/lib/connectionRuns.test.ts src/lib/finalHardening.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit durable deletion recovery**

```bash
git add postgres-interface/src/lib/deletePostgresConnection.ts postgres-interface/src/lib/deletePostgresConnection.test.ts
git commit -m "feat: recover postgres connection deletion runs"
```

### Task 6: Build the Accessible Selection and Confirmation Dialog

**Files:**

- Create: `postgres-interface/src/components/DeleteConnectionDialog.tsx`
- Create: `postgres-interface/src/components/DeleteConnectionDialog.test.tsx`
- Reuse: `postgres-interface/src/components/useDialogFocus.ts`
- Reuse: `postgres-interface/src/components/ActionButton.tsx`

**Interfaces:**

- Consumes: `DeleteConnectionApprovalContext` and `busy: boolean`.
- Produces callbacks: `onApprove(connectionId: string)` and `onReject()`.

- [ ] **Step 1: Write failing selection, consequence, and accessibility tests**

Create `DeleteConnectionDialog.test.tsx`:

```tsx
const created = {
  id: 'connection-created',
  access: { scope: 'database', operation: 'create', database: 'orders' },
} as const;
const existing = {
  id: 'connection-existing',
  access: { scope: 'database', operation: 'existing', database: 'warehouse' },
} as const;
const full = { id: 'connection-full', access: { scope: 'full', superuser: false } } as const;

function renderDialog(overrides: Partial<DeleteConnectionDialogProps> = {}) {
  const props: DeleteConnectionDialogProps = {
    context: {
      callingManagerId: 'consumer-manager',
      requestedConnectionId: null,
      choices: [created],
    },
    busy: false,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    ...overrides,
  };
  return { ...render(<DeleteConnectionDialog {...props} />), props };
}

it('requires selection and explains the exact destructive consequence', async () => {
  const user = userEvent.setup();
  const onApprove = vi.fn();
  renderDialog({
    context: {
      callingManagerId: 'consumer-manager',
      requestedConnectionId: null,
      choices: [created, existing, full],
    },
    onApprove,
  });
  const dialog = screen.getByRole('dialog', { name: 'Delete PostgreSQL connection?' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(screen.getByRole('button', { name: 'Delete connection' })).toBeDisabled();
  await user.click(screen.getByRole('radio', { name: /connection-created.*orders/i }));
  expect(screen.getByText(/database and user will be deleted/i)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Delete connection' }));
  expect(onApprove).toHaveBeenCalledWith('connection-created');
});

it.each([
  [existing, 'Only the connection user will be deleted'],
  [full, 'Only the connection user will be deleted'],
] as const)('preserves databases for %#', (choice, message) => {
  renderDialog({
    context: {
      callingManagerId: 'consumer-manager',
      requestedConnectionId: choice.id,
      choices: [choice],
    },
  });
  expect(screen.getByText(message)).toBeVisible();
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
});
```

Add the accessibility and busy-state tests:

```tsx
it('traps focus and permits Escape or Cancel before submission', async () => {
  const user = userEvent.setup();
  const onReject = vi.fn();
  renderDialog({
    context: {
      callingManagerId: 'consumer-manager',
      requestedConnectionId: created.id,
      choices: [created],
    },
    onReject,
  });
  const dialog = screen.getByRole('dialog');
  await waitFor(() => expect(dialog).toHaveFocus());
  await user.tab();
  await user.tab({ shift: true });
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  await user.keyboard('{Escape}');
  expect(onReject).toHaveBeenCalledOnce();
});

it('locks dismissal and announces work while busy', async () => {
  const user = userEvent.setup();
  const onReject = vi.fn();
  renderDialog({
    context: {
      callingManagerId: 'consumer-manager',
      requestedConnectionId: created.id,
      choices: [created],
    },
    busy: true,
    onReject,
  });
  expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('status')).toHaveTextContent('Deleting PostgreSQL connection');
  expect(screen.getByRole('button', { name: 'Delete connection' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(onReject).not.toHaveBeenCalled();
});

it('never renders credentials or remembered approval', () => {
  renderDialog({
    context: {
      callingManagerId: 'consumer-manager',
      requestedConnectionId: created.id,
      choices: [created],
    },
  });
  expect(screen.queryByText(/logical-password|admin-password/)).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: /remember|again/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the dialog test and verify RED**

Run: `npm test -- src/components/DeleteConnectionDialog.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the focused destructive dialog**

Create the component with this public contract:

```tsx
export interface DeleteConnectionDialogProps {
  context: DeleteConnectionApprovalContext;
  busy: boolean;
  onApprove: (connectionId: string) => void;
  onReject: () => void;
}
```

Initialize selection to the only choice when `requestedConnectionId` is non-null; otherwise initialize to `null`. Render radio choices only in selection mode. Derive consequence copy from access:

```ts
const deletesDatabase = choice.access.scope === 'database' && choice.access.operation === 'create';
```

Use `useDialogFocus<HTMLDivElement>(!busy, onReject)`, the same modal shell classes as `ConnectionApprovalDialog`, a rose danger action, and fixed copy. Render only connection ID, database/access description, caller ID, and consequence. Never accept or render a full target containing credentials.

- [ ] **Step 4: Run the dialog test and verify GREEN**

Run: `npm test -- src/components/DeleteConnectionDialog.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the deletion dialog**

```bash
git add postgres-interface/src/components/DeleteConnectionDialog.tsx postgres-interface/src/components/DeleteConnectionDialog.test.tsx
git commit -m "feat: confirm postgres connection deletion"
```

### Task 7: Adapt the Workflow to the Child Wire and Route It Through App

**Files:**

- Create: `postgres-interface/src/components/DeleteConnectionRequest.tsx`
- Create: `postgres-interface/src/components/DeleteConnectionRequest.test.tsx`
- Modify: `postgres-interface/src/App.tsx`
- Modify: `postgres-interface/src/App.test.tsx`

**Interfaces:**

- Consumes: parsed delete metadata and trusted current/calling manager IDs.
- Produces: exactly one `wire.close` success/error response.
- Extends: `View` with a distinct delete child view retained across run events.

- [ ] **Step 1: Write failing child-adapter tests**

Create `DeleteConnectionRequest.test.tsx` with fixed error mapping and exactly-once lifecycle coverage:

```tsx
const resource = {
  id: 'resource-1',
  type: 'postgres',
  name: 'postgres',
  manager: 'postgres-manager',
  external: false,
  agent: 'agent-1',
  created_at: 'now',
  updated_at: 'now',
} as RPC.ResourceItem;
function baseProps(caller: RPCCaller, wire: Wire) {
  return {
    caller,
    wire,
    events: createRunEventSource(),
    currentManagerId: 'postgres-manager',
    callingManagerId: 'consumer-manager',
    metadata: { connectionId: null },
  };
}
const deletionPlatform = { type: 'Platform' as const, data: { network: 'postgres-network' } };
const deletionLogin = {
  username: 'dc_user_0123456789abcdef0123456789abcdef',
  password: 'logical-password',
};
function resourceDetails() {
  return {
    resource,
    config: {
      id: resource.id,
      manager: resource.manager,
      agent: resource.agent,
      resource_type: 'postgres',
      name: 'postgres',
      metadata: {
        engine: 'postgres',
        version: '15',
        administrator: {
          username: 'dc_admin_0123456789abcdef0123456789abcdef',
          password: 'admin-password',
        },
      },
      platform_connection: deletionPlatform,
    },
  };
}
function connectionFixture(access: AccessRequest) {
  const database = access.scope === 'database' ? access.database : 'postgres';
  const labels =
    access.scope === 'database'
      ? { 'postgres.access': 'database', 'postgres.database': database }
      : { 'postgres.access': 'full' };
  return {
    connection: {
      id: 'connection-1',
      manager: 'consumer-manager',
      resource: resource.id,
      external: false,
      created_at: 'now',
      updated_at: 'now',
      labels,
    },
    config: {
      id: 'connection-1',
      manager: 'consumer-manager',
      resource: resource.id,
      metadata: {
        host: 'postgres',
        port: 5432,
        database,
        ...deletionLogin,
        access,
        platform_connection: deletionPlatform,
      },
    },
  };
}

function installedDeletionCaller() {
  const target = connectionFixture({
    scope: 'database',
    operation: 'create',
    database: 'orders',
  });
  let started: StartRunOptions | null = null;
  return {
    getMyResources: vi.fn().mockResolvedValue({
      items: [resource],
      limit: 50,
      offset: 0,
      total: 1,
    }),
    getResource: vi.fn().mockResolvedValue(resourceDetails()),
    getConnections: vi.fn().mockResolvedValue({
      items: [target.connection],
      limit: 50,
      offset: 0,
      total: 1,
    }),
    getConnection: vi.fn().mockResolvedValue(target),
    getRuns: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
    start: vi.fn().mockImplementation(async (options: StartRunOptions) => {
      started = options;
      return { id: 'cleanup-run', status: 0, queued_at: 'now' };
    }),
    getRun: vi.fn().mockImplementation(async () => ({
      run: {
        id: 'cleanup-run',
        action: 'cleanup-connection',
        status: 2,
        note: started?.note,
        queued_at: 'now',
        created_at: 'now',
        updated_at: 'now',
      },
      config: {
        id: 'cleanup-run',
        run: 'cleanup-run',
        action: 'cleanup-connection',
        manager: 'postgres-manager',
        runner: 'ezenki/deploy-commander-runner:latest',
        metadata: started?.metadata,
      },
    })),
    deleteConnection: vi.fn().mockResolvedValue(undefined),
  } as unknown as RPCCaller;
}

it.each([
  ['A calling manager is required', 400, 'A calling manager is required'],
  [
    'Invalid PostgreSQL connection deletion request',
    400,
    'Invalid PostgreSQL connection deletion request',
  ],
  ['PostgreSQL connection was not found', 404, 'PostgreSQL connection was not found'],
  [
    'PostgreSQL connection changed during deletion',
    409,
    'PostgreSQL connection changed during deletion',
  ],
  [
    'PostgreSQL connection deletion was cancelled',
    499,
    'PostgreSQL connection deletion was cancelled',
  ],
  ['PostgreSQL recovery is required', 503, 'PostgreSQL recovery is required'],
])('maps %s to a fixed close response', async (error, status, message) => {
  const wire = { close: vi.fn() } as unknown as Wire;
  render(<DeleteConnectionRequest {...baseProps({} as RPCCaller, wire)} initialError={error} />);
  await waitFor(() =>
    expect(wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { status, message },
    }),
  );
});

it('keeps the dialog busy and closes with only the deleted id', async () => {
  const wire = { close: vi.fn() } as unknown as Wire;
  const user = userEvent.setup();
  render(
    <DeleteConnectionRequest
      {...baseProps(installedDeletionCaller(), wire)}
      metadata={{ connectionId: 'connection-1' }}
    />,
  );
  await user.click(await screen.findByRole('button', { name: 'Delete connection' }));
  expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
  await waitFor(() =>
    expect(wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: true,
      result: { connection: 'connection-1' },
    }),
  );
  expect(JSON.stringify(wire.close.mock.calls)).not.toContain('logical-password');
});
```

Add lifecycle/redaction cases:

```tsx
it('maps a secret-bearing unexpected error to a fixed 500', async () => {
  const wire = { close: vi.fn() } as unknown as Wire;
  render(
    <DeleteConnectionRequest
      {...baseProps({} as RPCCaller, wire)}
      initialError="logical-password appeared in a backend error"
    />,
  );
  await waitFor(() =>
    expect(wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { status: 500, message: 'Unable to delete the PostgreSQL connection' },
    }),
  );
});

it('does not restart on rerender and does not close after unmount', async () => {
  const caller = installedDeletionCaller();
  let resolveResource: (value: unknown) => void = () => undefined;
  (caller.getResource as ReturnType<typeof vi.fn>).mockReturnValue(
    new Promise((resolve) => {
      resolveResource = resolve;
    }),
  );
  const wire = { close: vi.fn() } as unknown as Wire;
  const props = baseProps(caller, wire);
  const view = render(<DeleteConnectionRequest {...props} />);
  await waitFor(() => expect(caller.getResource).toHaveBeenCalledOnce());
  view.rerender(<DeleteConnectionRequest {...props} />);
  expect(caller.getResource).toHaveBeenCalledOnce();
  view.unmount();
  resolveResource(resourceDetails());
  await Promise.resolve();
  expect(wire.close).not.toHaveBeenCalled();
});

it('cancels without starting or deleting and closes once', async () => {
  const caller = installedDeletionCaller();
  const wire = { close: vi.fn() } as unknown as Wire;
  const user = userEvent.setup();
  render(<DeleteConnectionRequest {...baseProps(caller, wire)} />);
  await user.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(wire.close).toHaveBeenCalledTimes(1));
  expect(caller.start).not.toHaveBeenCalled();
  expect(caller.deleteConnection).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write failing App routing tests**

Extend `App.test.tsx` with:

```tsx
const deletionPlatform = { type: 'Platform' as const, data: { network: 'postgres-network' } };
function resourceDetails() {
  return {
    resource,
    config: {
      id: resource.id,
      manager: resource.manager,
      agent: resource.agent,
      resource_type: 'postgres',
      name: 'postgres',
      metadata: {
        engine: 'postgres',
        version: '15',
        administrator: {
          username: 'dc_admin_0123456789abcdef0123456789abcdef',
          password: 'admin-password',
        },
      },
      platform_connection: deletionPlatform,
    },
  };
}
function connectionFixture(access: AccessRequest) {
  const database = access.scope === 'database' ? access.database : 'postgres';
  const labels =
    access.scope === 'database'
      ? { 'postgres.access': 'database', 'postgres.database': database }
      : { 'postgres.access': 'full' };
  return {
    connection: {
      id: 'connection-1',
      manager: 'caller-manager',
      resource: resource.id,
      external: false,
      created_at: 'now',
      updated_at: 'now',
      labels,
    },
    config: {
      id: 'connection-1',
      manager: 'caller-manager',
      resource: resource.id,
      metadata: {
        host: 'postgres',
        port: 5432,
        database,
        username: 'dc_user_0123456789abcdef0123456789abcdef',
        password: 'logical-password',
        access,
        platform_connection: deletionPlatform,
      },
    },
  };
}

function deletionCallerOverrides(): Partial<RPCCaller> {
  const target = connectionFixture({
    scope: 'database',
    operation: 'create',
    database: 'orders',
  });
  return {
    getMyResources: vi.fn().mockResolvedValue({
      items: [resource],
      limit: 50,
      offset: 0,
      total: 1,
    }),
    getResource: vi.fn().mockResolvedValue(resourceDetails()),
    getConnections: vi.fn().mockResolvedValue({
      items: [target.connection],
      limit: 50,
      offset: 0,
      total: 1,
    }),
    getConnection: vi.fn().mockResolvedValue(target),
    getRuns: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0, total: 0 }),
  };
}

it('routes exact delete metadata without entering the dashboard', async () => {
  const current = fixture(deletionCallerOverrides(), { action: 'delete-connection' });
  render(<App createClient={current.factory} />);
  expect(
    await screen.findByRole('dialog', { name: 'Delete PostgreSQL connection?' }),
  ).toBeVisible();
  expect(current.caller.getCallingManager).toHaveBeenCalledOnce();
});

it('passes a supplied connection id and keeps the delete child stable across run events', async () => {
  const current = fixture(deletionCallerOverrides(), {
    action: 'delete-connection',
    connection: 'connection-1',
  });
  render(<App createClient={current.factory} />);
  await screen.findByRole('dialog', { name: 'Delete PostgreSQL connection?' });
  current.publish({
    eventType: 'run-update',
    event: 'event',
    data: { type: 'event', payload: {} },
  } as never);
  expect(current.caller.getMetadata).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
});

it('closes malformed delete metadata with a normalized 400 before discovery', async () => {
  const current = fixture({}, { action: 'delete-connection', connection: '' });
  render(<App createClient={current.factory} />);
  await waitFor(() =>
    expect(current.wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { status: 400, message: 'Invalid PostgreSQL connection deletion request' },
    }),
  );
  expect(current.caller.getMyResources).not.toHaveBeenCalled();
});
```

Retain existing create and dashboard routing assertions.

- [ ] **Step 3: Run component and App tests and verify RED**

Run:

```bash
npm test -- src/components/DeleteConnectionRequest.test.tsx src/App.test.tsx
```

Expected: FAIL because the child adapter and App delete route do not exist.

- [ ] **Step 4: Implement the child adapter**

Model `DeleteConnectionRequest` on the existing create adapter but keep the approval dialog mounted while busy. Its effect calls `deletePostgresConnection` with `waitForRun`, translates `requestApproval` through a pending resolver, aborts on cleanup, and guards close with `closedRef`.

Use this fixed mapper:

```ts
function errorResponse(error: unknown): { status: number; message: string } {
  if (error instanceof PostgresRequestError) {
    const messages: Record<number, string> = {
      400: 'Invalid PostgreSQL connection deletion request',
      404: 'PostgreSQL connection was not found',
      409: 'PostgreSQL connection changed during deletion',
      499: 'PostgreSQL connection deletion was cancelled',
    };
    return {
      status: error.status,
      message: messages[error.status] ?? 'Unable to delete the PostgreSQL connection',
    };
  }
  if (error instanceof Error) {
    const statuses: Record<string, 400 | 404 | 409 | 499 | 503> = {
      'A calling manager is required': 400,
      'Invalid PostgreSQL connection deletion request': 400,
      'PostgreSQL connection was not found': 404,
      'PostgreSQL connection changed during deletion': 409,
      'PostgreSQL connection deletion was cancelled': 499,
      'PostgreSQL recovery is required': 503,
    };
    const status = statuses[error.message];
    if (status !== undefined) return { status, message: error.message };
  }
  return { status: 500, message: 'Unable to delete the PostgreSQL connection' };
}
```

The progress shell uses badge `Deleting`, eyebrow `Logical database request`, and fixed status copy without credentials.

- [ ] **Step 5: Add the delete view and exact routing to App**

Import `DeleteConnectionRequest`, `parseDeleteConnectionRequest`, and its parsed type. Split the current child view into discriminated create/delete variants:

```ts
type CreateConnectionView = {
  kind: 'create-connection';
  manager: string;
  callerId: string | null;
  metadata: ParsedConnectionRequest;
  error: string | null;
};
type DeleteConnectionView = {
  kind: 'delete-connection';
  manager: string;
  callerId: string | null;
  metadata: ParsedDeleteConnectionRequest;
  error: string | null;
};
type ChildView = CreateConnectionView | DeleteConnectionView;

const EMPTY_DELETE_REQUEST: ParsedDeleteConnectionRequest = { connectionId: null };

function childAction(value: unknown): 'create-connection' | 'delete-connection' | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const action = (value as { action?: unknown }).action;
  return action === 'create-connection' || action === 'delete-connection' ? action : null;
}
```

Use `childAction` only to enter child mode; let the exact parser produce the child `400`. In the delete parse catch, store `EMPTY_DELETE_REQUEST` plus `Invalid PostgreSQL connection deletion request`, exactly as create mode stores its safe empty request plus an initial error. Store either child variant in one stable `childViewRef`. Render the existing `ConnectionRequest` for create and the new `DeleteConnectionRequest` for delete. Leave dashboard boot and lifecycle logic unchanged.

- [ ] **Step 6: Run child, App, and existing create UI tests**

Run:

```bash
npm test -- src/components/DeleteConnectionDialog.test.tsx src/components/DeleteConnectionRequest.test.tsx src/components/ConnectionRequest.test.tsx src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit the child action route**

```bash
git add postgres-interface/src/components/DeleteConnectionRequest.tsx postgres-interface/src/components/DeleteConnectionRequest.test.tsx postgres-interface/src/App.tsx postgres-interface/src/App.test.tsx
git commit -m "feat: route postgres connection deletion action"
```

### Task 8: Strengthen PostgreSQL Integration Coverage and Publish the Contract

**Files:**

- Modify: `postgres-interface/src/lib/postgresIntegration.test.ts`
- Modify: `postgres-interface/README.md`
- Modify: `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md`

**Interfaces:**

- Documents: both delete request forms, safe result, ownership, error contract, database effects, and retry behavior.
- Verifies: cleanup remains idempotent for all access modes against PostgreSQL 15.

- [ ] **Step 1: Add failing/strengthened idempotency assertions to the integration test**

In each cleanup path, call `cleanupAccess(access, seed)` twice. For created-database cleanup, assert the database and role remain absent after the second call. For existing-database and both full-access modes, assert the role remains absent and the database inventory remains intact. Add output redaction assertions for both cleanup calls:

```ts
const firstCleanup = await cleanupAccess(access, seed);
const secondCleanup = await cleanupAccess(access, seed);
for (const output of [firstCleanup, secondCleanup]) {
  expect(`${output.stdout}\n${output.stderr}`).not.toContain(password);
  expect(`${output.stdout}\n${output.stderr}`).not.toContain(login.password);
}
```

- [ ] **Step 2: Run the integration test in its default skipped mode**

Run: `npm test -- src/lib/postgresIntegration.test.ts`

Expected: PASS with the suite skipped when `POSTGRES_INTEGRATION_CONTAINER` is unset.

If a disposable PostgreSQL container is available, also run the README command and expect every access/cleanup case to pass. Do not start or remove a container unless the execution environment explicitly permits it.

- [ ] **Step 3: Update the README contract**

Replace the create-only interface paragraph with both actions:

````md
Create a connection:

```json
{ "action": "create-connection" }
```

Delete a specific owned connection, or omit `connection` to let the user select:

```json
{ "action": "delete-connection", "connection": "<connection-id>" }
```

```json
{ "action": "delete-connection" }
```
````

Document that caller identity is trusted host context, every deletion requires confirmation, created databases are deleted with their users, pre-existing/full-access databases survive, cleanup precedes record deletion, and success returns `{ "connection": "<deleted-connection-id>" }`. Remove the obsolete statement that individual connection deletion is undefined.

- [ ] **Step 4: Extend the integration guide**

Add a `Delete a connection` section after connection use. Include the exact request/result JSON, selection behavior, ownership checks, the four access/effect rows from the spec, and retry ordering. Extend the failure table so delete `404`, `409`, `499`, `500`, and `503` meanings are explicit without weakening create semantics.

- [ ] **Step 5: Run formatting checks**

Run:

```bash
npm run format
npm run format:check
```

Expected: both source and integration guide are formatted; check passes.

- [ ] **Step 6: Commit tests and public documentation**

```bash
git add postgres-interface/src/lib/postgresIntegration.test.ts postgres-interface/README.md docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md
git commit -m "docs: publish postgres connection deletion contract"
```

### Task 9: Run Full Verification

**Files:**

- Verify only; no planned source edits.

**Interfaces:**

- Confirms: the complete implementation, existing create workflow, lifecycle dashboard, type system, lint rules, formatting, and production bundle.

- [ ] **Step 1: Run the complete unit/component suite**

Run: `npm test`

Expected: all non-opt-in tests pass; PostgreSQL integration is skipped unless configured.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: zero ESLint errors.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: TypeScript project build and Vite production bundle succeed.

- [ ] **Step 4: Recheck formatting**

Run: `npm run format:check`

Expected: all checked files conform to Prettier.

- [ ] **Step 5: Inspect repository scope**

Run:

```bash
git status --short
git diff --stat HEAD~8..HEAD
git log -9 --oneline
```

Expected: only the planned source, test, and documentation files changed; commits are task-scoped. If the executor needed a corrective verification commit, include only those corrections and name the failing verification it fixes.
