# PostgreSQL Group Connections and Secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the unreleased PostgreSQL manager satisfy the resource connection group contract while storing administrator and login credentials only as Deploy Commander secrets.

**Architecture:** Parse and validate resource-scoped child requests, keep PostgreSQL access state in existing labels and public metadata, and use version-one runner secret references plus run-to-object secret copying. Link and unlink change only group labels through the authorized resource owner; creation and deletion retain their approval and runner workflows.

**Tech Stack:** React 19, TypeScript 5.9, Vitest, `@ezenki/deploy-commander-installer-interface` 0.7.0, Deploy Commander runner values contract.

**Spec:** `docs/superpowers/specs/2026-10-17-postgres-group-connections-and-secrets-design.md`

## Global Constraints

- New writes contain no administrator or connection username/password in resource metadata, connection metadata, runner metadata, labels, logs, or child results.
- Run secret keys and copied object secret keys are exactly `USERNAME` and `PASSWORD`; connection metadata declares `secret_keys: ["USERNAME", "PASSWORD"]`.
- Every secret-using runner plan sets `values_version: 1`; deploy only with a runner image implementing that contract.
- No credential migration or legacy plaintext fallback is needed; this manager has not been released.
- Create and delete make no state-changing RPC before their existing approvals. Link and unlink need no extra approval but must validate resource and connection ownership.
- Preserve unrelated labels. Group membership uses exactly `custom_deployer_group_id`; origin uses exactly `custom_deployer_connection_origin` with `created` or `imported`.
- Run the implementation natively in Luna after plan review. If an implementation worktree is used, report whether it was merged and offer the user the option to merge it.

## Review Focus

1. Two groups request identical PostgreSQL access: each must get a distinct login and neither can rotate the other's password. Task 1 tests identity separation; Task 4 tests group-scoped reuse.
2. One label RPC fails during link or unlink: group visibility must remain safe and a retry must finish cleanly. Task 5 tests both partial orders.
3. A created resource or connection lacks one copied secret: the child must fail verification without claiming success. Tasks 2 and 4 test absent keys.
4. An explicit delete array names an imported or foreign-resource connection: reject the whole array before cleanup. Task 6 tests both.
5. A values-capable runner cannot be confirmed at deployment: tests prove serialization, and the guide states the deployment prerequisite. Tasks 3 and 7 check the plan and documentation; no test can establish the deployed image version here.

## File map

- `postgres-interface/package.json`, `package-lock.json`: upgrade the interface library to 0.7.0 for run secrets and `getSecretKeys`.
- `src/domain/requests.ts`, `requests.test.ts`: parse resource-scoped create, link, and unlink requests; validate group label pairs.
- `src/domain/credentials.ts`, `credentials.test.ts`: include group ID in group-created login identity.
- `src/platform/secrets.ts`, `secrets.test.ts`: verify object secret key names without reading values.
- `src/platform/resources.ts`, `resources.test.ts`: resolve the exact requested owned resource and validate secret-backed installation.
- `src/platform/connections.ts`, `connections.test.ts`: validate public connection metadata and secret keys; match reuse within a group.
- `src/platform/plans.ts`, `plans.test.ts`: serialize version-one secret references and copy lists.
- `src/workflows/lifecycle.ts`, `lifecycle.test.ts`: send installation credentials as run secrets and verify resource keys.
- `src/workflows/createConnection.ts`, `createConnection.test.ts`: use requested resource, group-scoped identity, run secrets, and identity-only results.
- `src/workflows/groupConnection.ts`, `groupConnection.test.ts`: link and unlink group labels with ownership checks and verification.
- `src/workflows/deleteConnection.ts`, `deleteConnection.test.ts`: authorize explicit arrays by resource, reject imported connections, and use secret-backed cleanup plans.
- `src/app/App.tsx`, `App.test.tsx`, `src/test/fakes.ts`: route four child actions and provide secret/label test doubles.
- `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md`: publish the new request, result, secret, and runner contracts.

---

### Task 1: Request contract, dependency, and group login identity

**Files:** Modify `postgres-interface/package.json`, `package-lock.json`, `src/domain/requests.ts`, `requests.test.ts`, `src/domain/credentials.ts`, `credentials.test.ts`.

**Interfaces:** `ParsedCreateRequest` gains `resourceId: string`. Add `ParsedLinkRequest = { action: 'link-connection'; resourceId: string; connectionId: string; labels: Record<string,string> }` and `ParsedUnlinkRequest = { action: 'unlink-connection'; resourceId: string; connectionId: string; groupId: string }`; export `parseLinkRequest(value: unknown)` and `parseUnlinkRequest(value: unknown)`. `LoginIdentity` gains optional `groupId?: string`; `generateLoginCredentials(identity: LoginIdentity): Promise<LoginCredentials>` keeps its signature.

- [ ] **Step 1: Write failing parser and identity tests.** Assert a create request with `resource: 'resource-1'` returns `resourceId: 'resource-1'`; missing/blank resource and incomplete or contradictory group labels yield status 400. Assert link accepts exactly one nonblank group ID with origin `imported`, unlink accepts nonblank `resource`, `connection`, and `group`, and both reject manager identity fields. Assert two identities differing only in `groupId` produce different usernames and a repeated group identity produces the same username.
- [ ] **Step 2: Run `npm test -- --run src/domain/requests.test.ts src/domain/credentials.test.ts` from `postgres-interface`; expect the new tests to fail.**
- [ ] **Step 3: Upgrade the package with `npm install @ezenki/deploy-commander-installer-interface@0.7.0` and implement the parsers and group-scoped digest.** Keep the existing optional access selection and reserved `postgres.*` rejection. Require `custom_deployer_group_id` and `custom_deployer_connection_origin=created` together on create; non-group creates omit both. Use a separate group-id component in the digest so non-group identities retain their former format.
- [ ] **Step 4: Run the two focused tests; expect PASS. Commit the package and domain changes.**

### Task 2: Secret-backed resource and connection projections

**Files:** Create `postgres-interface/src/platform/secrets.ts`, `secrets.test.ts`; modify `src/platform/resources.ts`, `resources.test.ts`, `src/platform/connections.ts`, `connections.test.ts`, `src/test/fakes.ts`.

**Interfaces:** `requireCredentialKeys(caller: RPCCaller, kind: 'resource' | 'connection', id: string): Promise<void>` calls `getSecretKeys(kind,id)` and requires both exact keys. Add `resolveOwnedPostgresResource(caller: RPCCaller, managerId: string, resourceId: string): Promise<RPC.ResourceItem>`. `PostgresInstallation` becomes `{ resource: RPC.ResourceItem }`. `PostgresConnection` removes `username` and `password`; `readPostgresConnection` returns only public metadata and authority. `findCompatibleConnection` includes exact group ID or exact absence in its input match.

- [ ] **Step 1: Write failing tests.** Resource and connection details with `secret_keys: ['USERNAME','PASSWORD']`, no credential values, and successful `getSecretKeys` resolve; a missing key, an unexpected plaintext credential field, or mismatched resource fails. A connection in group B must not satisfy group A's lookup even with the same access. Retain the paginated peer-list test.
- [ ] **Step 2: Run `npm test -- --run src/platform/secrets.test.ts src/platform/resources.test.ts src/platform/connections.test.ts`; expect FAIL.**
- [ ] **Step 3: Implement key-name checks, exact-resource resolution, public metadata validation, and group-aware matching.** Use `getSecretKeys` only for names; no code path reads a stored value. Remove the existing connection `console.log` that prints full details. Update fake caller defaults for `getSecretKeys`.
- [ ] **Step 4: Run the three focused tests; expect PASS. Commit projection changes.**

### Task 3: Values-versioned runner plans

**Files:** Modify `postgres-interface/src/platform/plans.ts`, `plans.test.ts`.

**Interfaces:** `buildInstallPlan(): RunnerMetadata`; `buildProvisionPlan({ installation, callerId, access, origin, databaseOwner, callerLabels }): RunnerMetadata`; existing `buildDeletePlan` and `buildBatchDeletePlan` keep their input shapes except targets no longer contain credentials. `RunnerMetadata` gains `values_version?: 1`; resource and connection create specs gain `secrets?: string[]`.

- [ ] **Step 1: Write failing plan tests.** Assert install uses `values_version: 1`, environment `[[secret:run:USERNAME]]` and `[[secret:run:PASSWORD]]`, resource `secrets: ['USERNAME','PASSWORD']`, and public resource metadata. Assert provision uses resource secret references for `PGUSER`/`PGPASSWORD`, run secret references for `TARGET_USERNAME`/`TARGET_PASSWORD`, copies both keys to the connection, and declares `secret_keys` without credential values. Assert single and batch cleanup use `[[secret:connection:<id>:USERNAME]]` for every target and contain no literal login. Assert `JSON.stringify(plan)` lacks supplied test credential values.
- [ ] **Step 2: Run `npm test -- --run src/platform/plans.test.ts`; expect FAIL.**
- [ ] **Step 3: Implement secret-reference serialization in supported service environment positions and copy arrays.** Keep SQL scripts and cleanup order. Use the existing resource/connection IDs verbatim in references; IDs are validated by the authoritative reads.
- [ ] **Step 4: Run the focused tests, including shell syntax and one-shot script tests; expect PASS. Commit runner-plan changes.**

### Task 4: Install and create through run secrets

**Files:** Modify `postgres-interface/src/workflows/lifecycle.ts`, `lifecycle.test.ts`, `src/workflows/createConnection.ts`, `createConnection.test.ts`.

**Interfaces:** `createPostgresConnection(deps, request): Promise<{ connection: RPC.ConnectionItem }>`; request metadata uses `ParsedCreateRequest.resourceId`. `installPostgres` and create pass `StartRunOptions.secrets = { USERNAME, PASSWORD }`; no credential enters `metadata`.

- [ ] **Step 1: Write failing workflow tests.** Install passes generated credentials only in `secrets`, then requires both copied resource keys. Create rejects wrong resource before approval, makes no mutation before approval, sends generated login only in run secrets, creates group-specific roles for identical access, reuses only the exact group connection, verifies published secret keys, and returns `{connection}` without `config`. A missing copied key or failed run yields a failed result without secret text.
- [ ] **Step 2: Run `npm test -- --run src/workflows/lifecycle.test.ts src/workflows/createConnection.test.ts`; expect FAIL.**
- [ ] **Step 3: Implement the new plan calls and post-run checks.** Keep the approval and active-run safeguards, origin calculation, and persistence polling. Use requested resource resolution before accepting a result. Replace the old username-based incompatible-publication check with group/label/access checks because username is no longer readable.
- [ ] **Step 4: Run the two focused tests; expect PASS. Commit install/create changes.**

### Task 5: Link and unlink through the resource owner

**Files:** Create `postgres-interface/src/workflows/groupConnection.ts`, `groupConnection.test.ts`; modify `src/app/App.tsx`, `App.test.tsx`, `src/test/fakes.ts`.

**Interfaces:** `linkPostgresConnection(caller: RPCCaller, currentManagerId: string, request: ParsedLinkRequest): Promise<{ connection: RPC.ConnectionItem }>` and `unlinkPostgresConnection(caller: RPCCaller, currentManagerId: string, request: ParsedUnlinkRequest): Promise<{ connection: RPC.ConnectionItem }>`; add both to `AppServices` and child routing.

- [ ] **Step 1: Write failing workflow and App tests.** Link accepts a connection owned by another manager but attached to the exact owned resource; rejects foreign resource, another group, and `created` origin; sets origin before group ID; preserves unrelated labels; verifies the final read. Unlink removes group ID before origin, preserves connection and PostgreSQL role, rejects a `created` origin, succeeds on completed retry, and recovers from a partial unlink. Label RPC errors close as failures and never claim success. App dispatches both actions from metadata.
- [ ] **Step 2: Run `npm test -- --run src/workflows/groupConnection.test.ts src/app/App.test.tsx`; expect FAIL.**
- [ ] **Step 3: Implement the workflow with `setConnectionLabel`, `removeConnectionLabel`, and a fresh labeled `getConnection` after mutations.** Validate the exact resource through `resolveOwnedPostgresResource`; use `readPostgresConnection` for the target's PostgreSQL contract. Keep errors normalized and free of raw RPC payloads. Add child routing without an extra confirmation dialog.
- [ ] **Step 4: Run the two focused tests; expect PASS. Commit group-workflow and App changes.**

### Task 6: Resource-authorized deletion and secret-backed cleanup

**Files:** Modify `postgres-interface/src/workflows/deleteConnection.ts`, `deleteConnection.test.ts`, `src/app/App.test.tsx` as needed.

**Interfaces:** `deletePostgresConnection(deps, request): Promise<{ connection: string } | { connections: string[] }>` remains. Explicit arrays validate target resource ownership regardless of `connection.manager`; chooser remains caller-filtered.

- [ ] **Step 1: Write failing deletion tests.** An array with a connection owned by another manager but attached to the exact resource succeeds after approval. An imported-labeled target or a foreign-resource ID rejects the entire array before any run. Two targets from the same managed database still drop it only after the last target. Cleanup plan contains connection-username references and never reads password values. Post-approval changed labels, secret-key loss, or changed peer set fails before starting cleanup.
- [ ] **Step 2: Run `npm test -- --run src/workflows/deleteConnection.test.ts`; expect FAIL.**
- [ ] **Step 3: Replace caller-manager restriction for explicit arrays with exact resource validation, reject imported targets, and adapt fingerprint/revalidation to public metadata and secret keys.** Keep per-target approvals, ordered batch cleanup, and post-run absence verification. Do not send imported connections to PostgreSQL cleanup.
- [ ] **Step 4: Run the focused deletion and App tests; expect PASS. Commit deletion changes.**

### Task 7: Public guide and full verification

**Files:** Modify `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md`; touch tests only for a concrete regression found in verification.

**Interfaces:** Documentation describes all four actions, exact group labels, resource ownership, `secret_keys`, secret-free child results, failure statuses, and the values-capable runner requirement.

- [ ] **Step 1: Update the guide examples.** Replace plaintext resource and connection metadata and the old `RPC.CreateConnection` return example. Document `resource` on create, link/unlink request and result shapes, imported-versus-created removal, array deletion, and `USERNAME`/`PASSWORD` secret references.
- [ ] **Step 2: Run `npm test`, `npm run lint`, `npm run format:check`, and `npm run build` from `postgres-interface`; expect all to pass.** Run Prettier on the changed guide if the check requests it. Inspect built output and tests for credential literals in serialized plans/results and expected `values_version`/secret-reference markers.
- [ ] **Step 3: Review the diff against both source guides and the spec.** Verify no credential migration, no unrelated guide edit, and that the user's uncommitted runner-guide changes remain untouched. Fix only concrete gaps found, rerun the affected gate, then commit the guide and any fixes.
