# PostgreSQL Resource and Connection Authority Design

**Date:** 2026-09-19

**Status:** Approved in conversation; written specification awaiting review

## Summary

The PostgreSQL manager will derive durable state exclusively from Deploy Commander resources and connections. It will not use the Deploy Commander manager database, `databaseQuery`, a manager-local PostgreSQL database catalog, or completed run history as a second source of truth.

One exact owned PostgreSQL resource means the service is installed. PostgreSQL connections describe logical access through reserved labels. Database cleanup uses those connection labels to determine whether a manager-created database still has consumers. Runs remain execution records and transient busy signals, not durable lifecycle state.

This design supersedes the manager-database catalog and completed-run lifecycle portions of earlier PostgreSQL manager designs. It preserves explicit approval for create-connection, delete-connection, and teardown actions. Installation begins directly from the explicit Install button without a second confirmation dialog.

## Goals

- Make resources the only durable authority for PostgreSQL installation state.
- Make connections the only durable authority for logical access state.
- Remove every production `databaseQuery` call and runner database-query hook.
- Describe database, full-access, and database-origin semantics with reserved connection labels.
- Drop a database only when it was created by this manager and its final database-scoped connection is being deleted.
- Ignore completed run history when resolving current lifecycle state.
- Retain active-run checks solely for in-progress UI and mutation serialization.
- Keep the action approval gate for connection creation, connection deletion, and teardown.
- Remove the redundant installation confirmation dialog.
- Replace generic recovery errors with specific, actionable failures.

## Non-goals

- Discover every database that exists inside PostgreSQL independently of Deploy Commander connections.
- Treat full-access connections as consumers of every database.
- Store a database registry in resource labels, browser storage, or another service.
- Introduce a new database, queue, lock service, or persistence layer.
- Migrate or rewrite connection credentials.
- Use historical completed runs to reconstruct resources or connections.
- Automatically install PostgreSQL in response to a create-connection request.

## Authoritative State Model

### Installation state

The manager lists exact owned resources with all of these properties:

- `external === false`
- `type === "postgres"`
- `name === "postgres"`

The result determines durable installation state:

- Zero exact resources: PostgreSQL is not installed.
- One exact resource: PostgreSQL is installed.
- More than one exact resource: state is ambiguous and mutations are blocked.

Resource existence is sufficient to classify installation state. Completed create or teardown runs cannot contradict or override it.

The full resource configuration remains an operational input. Provisioning and cleanup require administrator credentials and a valid platform connection. Missing or malformed operational fields do not make the resource nonexistent; they produce the explicit error `PostgreSQL resource configuration is incomplete` when an operation needs those fields. Teardown remains available for an existing resource even when its provisioning configuration is incomplete.

### Transient run state

Active runs with status queued or running may be consulted to:

- show installation, teardown, provisioning, or cleanup progress;
- prevent overlapping PostgreSQL mutations;
- wait for the exact run started by the current action; and
- re-read that exact run when its event stream or initial response is interrupted.

Completed runs are not lifecycle state. The manager must not select the newest completed run to decide whether a resource or connection should exist. Retrying an operation re-reads resources and connections, then starts an idempotent operation when necessary.

### Connection state

Each PostgreSQL connection carries manager-owned reserved labels. Callers cannot supply or override these keys.

Database-scoped access uses:

```text
postgres.access=database
postgres.database=<normalized database name>
postgres.database-origin=managed|existing
```

Full access uses:

```text
postgres.access=full
```

Full-access connections must not carry `postgres.database` or `postgres.database-origin`.

`managed` means the database was created by this PostgreSQL manager. `existing` means the database existed independently when access was granted. The origin describes the database, so every database-scoped connection for the same resource and database must resolve to the same origin.

Connection metadata continues to contain credentials, access details, and the authoritative platform connection. Labels provide enumeration and deletion identity; metadata provides the complete validated connection contract.

## Legacy Connections

Existing connections may have `postgres.access` and `postgres.database` but no `postgres.database-origin` label. The manager derives origin from validated connection metadata:

- `access.scope === "database"` and `access.operation === "create"` resolves to `managed`.
- `access.scope === "database"` and `access.operation === "existing"` resolves to `existing`.
- Full access has no database origin.

Correctness must never depend on backfilling the label. A resolved legacy connection may be backfilled only after explicit approval of the action currently operating on it. Backfill failure must not widen deletion behavior. If origin cannot be established, role and connection deletion may proceed after approval, but the database must be preserved.

Conflicting origins for the same resource and database are invalid. The manager blocks database deletion and reports which database has conflicting connection state. It never guesses that the database is safe to drop.

## Database Discovery

The approval UI derives database suggestions from database-scoped connections associated with the exact PostgreSQL resource. It does not query the manager database and does not claim to enumerate every PostgreSQL database.

Users may still enter an existing database name that has no Deploy Commander connection. Such a request receives origin `existing`. If validated connections already exist for the requested database, their consistent origin is inherited by the new connection.

A create-new-database request receives origin `managed`. A conflicting connection or PostgreSQL collision fails explicitly rather than silently changing the request to existing access.

## Install Flow

The Install button is itself the user's explicit request. It does not open a confirmation dialog.

1. Disable the Install button immediately to prevent duplicate local submission.
2. Re-list exact PostgreSQL resources.
3. Refuse installation if a resource already exists or if more than one resource exists.
4. Check for an active PostgreSQL mutation run and return an operation-busy response when present.
5. Generate administrator credentials and start the installation run.
6. Wait for the exact run.
7. Refresh resources. Exactly one matching resource means installation succeeded.

A reload during installation may show progress by observing an active installation run. Once the run is terminal, resource existence alone determines the displayed state.

## Create-Connection Flow

A create-connection child action mounts the approval gate before caller discovery or preflight work. Preparation is read-only.

1. Identify the calling manager.
2. Require exactly one exact PostgreSQL resource. Zero resources returns `PostgreSQL is not installed`; multiple resources returns `Multiple PostgreSQL resources were found`.
3. Read and validate the resource's operational configuration.
4. Enumerate connections for that resource with labels included.
5. Validate reserved labels and complete metadata for relevant connections.
6. Derive database suggestions and any inherited database origin.
7. Present the approval dialog.
8. After approval, re-read the resource, relevant connections, and active mutation runs.
9. Return an existing exact connection when it already satisfies the caller, access, and non-reserved label request.
10. Start an idempotent provisioning run without any manager-database query hook.
11. Wait for the exact run and verify the published connection and labels.
12. Close the child wire with the validated connection.

No state-changing RPC occurs before approval. A create-connection request never installs PostgreSQL implicitly.

For a database request:

- `operation=create` produces `postgres.database-origin=managed`.
- `operation=existing` inherits a consistent origin from existing connections for the same resource/database, or uses `existing` when none exist.

For full access, only `postgres.access=full` is reserved.

## Delete-Connection Flow

A delete-connection child action also mounts the approval gate before caller discovery or preflight work. Preparation is read-only.

1. Identify the calling manager.
2. Require exactly one exact PostgreSQL resource.
3. Resolve either the requested connection ID or the caller's eligible connections.
4. Verify that the target belongs to the calling manager, references the exact resource, is internal, and has a valid PostgreSQL connection contract.
5. Resolve the target's access and database origin from labels, with the defined legacy fallback.
6. For database-scoped targets, enumerate all connections across all consuming managers for the same resource and database.
7. Present the target and cleanup consequence for approval.
8. After approval, re-read the resource, target, matching connections, and active mutation runs.
9. Choose the cleanup operation from the revalidated snapshot.
10. Run idempotent PostgreSQL cleanup.
11. Delete the target connection, accepting already-absent as success.
12. Close the child wire with only the deleted connection ID.

Cleanup selection is exact:

- Full access: drop only the target role.
- Database origin `existing`: drop only the target role.
- Database origin `managed` with another database-scoped connection to the same resource/database: drop only the target role.
- Database origin `managed` with no other database-scoped connection: drop the database and target role.
- Unknown or conflicting origin: preserve the database; drop only the target role.

Full-access connections do not count as connections to a specific database. Connections for other resources or databases do not count. The comparison uses the normalized exact database label, never substring or untrusted metadata matching.

Cleanup happens before connection deletion so a failed cleanup leaves an authoritative connection that can be retried. Mutation execution is blocked while another PostgreSQL mutation run is active. Cleanup SQL must remain idempotent for a retry after a lost response.

## Teardown Flow

Teardown remains destructive and requires confirmation.

1. Require at least one exact PostgreSQL resource; multiple resources are presented explicitly and must not be guessed away.
2. Refuse overlap with an active PostgreSQL mutation run.
3. After confirmation, start teardown and wait for that exact run.
4. Refresh resources.
5. Zero matching resources means teardown succeeded.

Teardown does not require valid administrator credentials because it removes the service through the platform plan.

## Approval Policy

- Install: the Install button is the approval; no popup.
- Create connection: approval dialog required before provisioning or connection mutation.
- Delete connection: approval dialog required before cleanup, label mutation, or connection deletion.
- Teardown: destructive confirmation dialog required.

Caller lookup, resource reads, connection reads, label validation, and active-run reads are allowed during preparation. `start`, connection creation/deletion, label mutation, resource mutation, and any other state-changing RPC are forbidden before the corresponding approval.

## Error Model

The UI and wire responses use specific, non-secret failures:

- `A calling manager is required`
- `PostgreSQL is not installed`
- `Multiple PostgreSQL resources were found`
- `PostgreSQL resource configuration is incomplete`
- `A PostgreSQL operation is already in progress`
- `Invalid PostgreSQL connection labels`
- `Conflicting PostgreSQL database origin for <database>`
- `PostgreSQL connection was not found`
- `PostgreSQL connection changed during deletion`
- action-specific installation, provisioning, cleanup, and publication failures

The generic `PostgreSQL recovery is required` message is not used for expected resource, connection, or run validation outcomes. Internal errors remain normalized and must not expose credentials, raw RPC payloads, SQL, runner metadata, or connection strings.

## Removed Architecture

The implementation removes or stops using:

- `postgresCatalog.ts` and its tests;
- `postgres_database` definitions and queries;
- `CATALOG_UPSERT_QUERY`, `CATALOG_DELETE_QUERY`, `CATALOG_MARK_CLEANUP_QUERY`, and `CATALOG_DELETE_OWNED_QUERY`;
- direct `caller.databaseQuery(...)` calls;
- runner object hooks containing database queries;
- catalog operation IDs and cleanup catalog reconciliation;
- manager-database bootstrap assumptions;
- completed-run lifecycle contradiction checks;
- completed provisioning/cleanup run scans used as durable state;
- automatic installation from connection creation; and
- installation confirmation state and UI.

The installer-interface dependency may continue to expose `databaseQuery`; this manager simply does not call it.

## Component Boundaries

- `postgresResource.ts` discovers exact resources and separately loads operational configuration.
- `postgresConnectionRequest.ts` owns reserved label names, construction, and validation.
- `postgresConnectionContract.ts` enumerates resource connections, validates summaries and details, resolves legacy origin, and computes remaining database consumers.
- `createPostgresConnection.ts` coordinates approved provisioning from resource and connection state.
- `deletePostgresConnection.ts` coordinates approved cleanup from a revalidated connection snapshot.
- `postgresRuns.ts` provides active-run detection and exact-run reads without completed-history lifecycle resolution.
- `lifecycleActions.ts` implements resource-based install and teardown.
- `ManagerDashboard.tsx` starts installation directly and confirms teardown.
- Approval components remain presentation and state-machine boundaries; they do not own workflow state.

## Security and Safety Invariants

- Administrator credentials remain confined to the resource's protected configuration and runner input.
- Logical credentials remain confined to connection configuration and runner input.
- Reserved labels contain no secrets.
- Caller-supplied labels cannot overwrite reserved labels.
- The manager validates both connection summaries and complete connection records before acting.
- Delete approval is scoped to the exact target shown to the user and is revalidated before mutation.
- A pre-existing or origin-unknown database is never dropped.
- A managed database is dropped only for its final database-scoped connection.
- No mutation occurs before its required approval.
- Errors and logs never expose credentials or raw backend data.

## Testing Strategy

### Static and contract checks

- Assert no production source calls `databaseQuery`.
- Assert generated run plans contain no database-query hook.
- Assert the manager-database catalog module and imports are removed.
- Assert reserved caller labels are rejected or replaced by authoritative values.

### Resource lifecycle

- Zero, one, and multiple exact resources resolve to not installed, installed, and ambiguous.
- Completed create and teardown runs do not alter resource-derived state.
- Active runs show progress and block overlapping mutation.
- An incomplete resource remains installed but returns a specific operational-configuration error.
- Install starts on the first button click and starts at most one run.
- Teardown still requires confirmation.

### Connection creation

- The approval gate is visible during caller and resource discovery.
- No mutation occurs before approval.
- Missing resources do not trigger automatic installation.
- New database access receives `managed` origin.
- Unconnected existing database access receives `existing` origin.
- Later connections inherit a consistent managed or existing origin.
- Full access carries no database labels.
- Existing exact connections are returned idempotently.
- Provisioning plans and published connections contain the expected labels and no manager-database hooks.

### Connection deletion

- A database shared by connections from two consuming managers is preserved when either non-final connection is deleted.
- The final connection to a managed database drops the database and role.
- The final connection to a pre-existing database drops only the role.
- Full-access deletion drops only the role.
- Other resources and database names do not affect the count.
- Legacy origin derives correctly from validated metadata.
- Unknown or conflicting origin preserves the database.
- Revalidation detects a changed target or changed peer set before cleanup.
- Cleanup failure leaves the connection available for retry.
- Double submission starts at most one cleanup and deletes at most one connection.

### End-to-end verification

- Run focused unit and component suites during each task.
- Run the full Vitest suite.
- Run ESLint and Prettier checks.
- Run the TypeScript and Vite production build.
- Run PostgreSQL integration coverage when its container environment is available.
- Inspect the built artifact for the expected approval-gate marker and absence of catalog query text.

## Documentation and Migration

The integration guide will document the reserved labels, resource-derived lifecycle, direct install behavior, and final-managed-connection deletion rule. Earlier design documents remain historical records; this specification explicitly supersedes their manager-database catalog and completed-run lifecycle decisions.

No standalone migration job is required. New connections always receive complete labels. Legacy connections are interpreted from their own validated metadata, and optional label backfill occurs only within an approved action. Existing manager-database catalog records become unused and may remain inert; production code neither reads nor writes them.

## Acceptance Criteria

- Production code contains no `databaseQuery` call.
- No PostgreSQL plan contains a manager-database query hook.
- Dashboard installation state is determined by resources, plus active-run progress only.
- Connection creation requires an existing resource and explicit approval.
- Connection deletion requires explicit approval and uses resource-wide connection labels to choose role-only versus role-and-database cleanup.
- Only the final database-scoped connection to a manager-created database can trigger database deletion.
- Installation starts directly from the Install button without a popup.
- Teardown remains confirmed.
- Expected inconsistencies produce specific errors rather than `PostgreSQL recovery is required`.
- Unit, component, integration-when-available, lint, formatting, and production-build verification pass.
