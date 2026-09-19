# PostgreSQL Manager Clean Rebuild Design

**Status:** Approved

**Date:** 2026-09-19

**Supersedes:**

- `2026-09-19-postgres-resource-connection-authority-design.md`
- all earlier PostgreSQL recovery, catalog, run-backed-state, and approval-gate designs

## Summary

Rebuild the deleted PostgreSQL manager as a small React/TypeScript manager whose durable state
comes exclusively from Deploy Commander resources and connections:

- a manager-owned PostgreSQL resource means PostgreSQL is installed;
- connections attached to that resource represent granted logical access;
- live runs and run events represent only an operation currently in progress.

The rebuilt manager has no recovery mode, manager database, PostgreSQL catalog mirror, completed-run
reconciliation, cleanup ledger, or `databaseQuery` usage. Connection creation and deletion always
require an explicit user decision before any run or mutation starts. The public request and success
response contract in `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md` remains compatible.

## Goals

1. Make resources the sole authority for installation state.
2. Make connections the sole authority for logical PostgreSQL access.
3. Use live `run-start` and `run-update` events to track starting and state changes for a run.
4. Require explicit approval for every create-connection and delete-connection request.
5. Delete a database only when it was created by this manager and its final connection is deleted.
6. Preserve the documented child-interface request variants and successful response shapes.
7. Scaffold the replacement with the official NPX initializer using React and TypeScript.
8. Retain the supported build and publishing workflow.

## Non-goals

- Restoring or adapting the deleted manager implementation.
- Migrating old private manager-database records, catalogs, cleanup histories, or recovery records.
- Inferring durable state from completed or failed runs.
- Automatically installing PostgreSQL in response to a connection request.
- Using Deploy Commander `databaseQuery` or runner object database hooks.
- Building a generic workflow engine or persistence abstraction.
- Reconstructing historical operations after the manager was deleted.

## Authoritative state model

### Installation

The manager lists its non-external resources with resource type `postgres` and selects the stable
resource named `postgres`.

| Matching resources | Dashboard state | Behavior |
| --- | --- | --- |
| 0 | Not installed | The Install action is available. Connection requests fail with `404`. |
| 1 | Installed | The resource ID is used for connection lookup and run targets. |
| More than 1 | Resource conflict | Mutations are blocked with a specific `409`; no recovery mode is entered. |

Resource existence alone determines whether the dashboard says PostgreSQL is installed. Detailed
resource configuration is loaded only when an operation needs administrator credentials or the
runner-generated platform connection. Missing or malformed operational configuration produces a
specific `400` configuration error; it does not change the installation projection and does not
produce a recovery state.

The resource configuration contains:

- resource type and stable name `postgres`;
- engine `postgres` and version `15`;
- generated administrator username and password;
- the runner-generated Docker platform connection.

### Logical access

Every logical access grant is represented by a Deploy Commander connection attached to the
PostgreSQL resource. The manager does not duplicate connection state anywhere else.

Reserved connection labels are:

| Label | Values | Presence |
| --- | --- | --- |
| `postgres.access` | `database` or `full` | Every PostgreSQL connection |
| `postgres.database` | database name | Database-scoped connections only |
| `postgres.database-origin` | `managed` or `existing` | Database-scoped connections only |

Full-access connections have `postgres.access=full` and no database labels. Their constrained or
superuser distinction remains in `config.metadata.access`, preserving the public response contract.

Caller labels are copied unchanged, but a caller may not supply any reserved label. Reserved-label
attempts fail with `400`.

For database access, origin is derived from resources and connections:

- a successful `operation=create` request creates a `managed` database;
- an `operation=existing` request inherits `managed` when another connection on the same resource
  already marks that database as managed;
- otherwise, `operation=existing` is labeled `existing`.

This propagation ensures that a manager-created database remains identifiable as managed after its
original connection is deleted.

### Runs

Runs are transient operation progress. They are never an installation or connection authority.

The application may load queued and running operations at startup solely to restore progress and
prevent duplicate mutations. It must ignore completed runs when computing installation and
connection state. It must not call `getLatestRun` or scan run history for recovery.

## Project scaffold and publishing

Implementation begins with the official initializer:

```bash
npx @ezenki/deploy-commander-installer-interface init postgres-interface \
  --framework react \
  --language typescript \
  --manager-name postgres \
  --manager-kind postgres \
  --manager-description "Installs PostgreSQL and manages approval-gated database connections" \
  --package-manager npm
```

The generated React, TypeScript, build, publish, and deploy configuration is retained. Generated
sample application code may be replaced.

`postgres-interface/deploy-commander.json` is:

```json
{
  "name": "postgres",
  "kind": "postgres",
  "description": "Installs PostgreSQL and manages approval-gated database connections",
  "buildDirectory": "dist"
}
```

Publishing labels are intentionally omitted so repeat publishes preserve labels configured in
Deploy Commander. The target and credentials belong in the ignored `.env`, represented by a
credential-free `.env.example`:

```dotenv
COMMANDER_URL=
COMMANDER_USERNAME=
COMMANDER_PASSWORD=
```

The generated `build`, `publish:manager`, and `deploy` scripts remain available.
`publish:manager` uploads an existing `dist` and does not silently run the build.

## Application structure

The replacement uses a small, direct layout:

```text
src/
├── app/                 startup, context loading, and root/child routing
├── domain/              request parsing and resource/connection projections
├── platform/            wire, RPC calls, runner plans, and run-event tracking
├── workflows/           install, uninstall, create connection, delete connection
└── components/          dashboard, approval dialogs, and progress/error views
```

No recovery framework, catalog module, generic state machine, historical reconciler, or private
persistence adapter is introduced.

## Interface modes

### Root dashboard

The root interface has no calling manager. It renders:

- installed/not-installed from the resource projection;
- a concrete resource conflict when more than one resource matches;
- connections attached to the installed resource;
- Install when not installed;
- Uninstall when installed;
- current operation progress driven by run events.

Clicking Install is the user's approval. It does not open a second confirmation dialog.

Uninstall is destructive and requires a single explicit confirmation that the PostgreSQL service,
volume, resource, and all databases will be destroyed. It is a separate administrative operation,
not a child delete-connection request.

### Child create request

Metadata with `action=create-connection` opens the create approval workflow. The manager obtains the
calling manager from trusted Deploy Commander context. Request metadata may not choose a manager,
resource, username, password, or platform connection.

### Child delete request

Metadata with `action=delete-connection` opens the delete approval workflow. A request may name a
connection ID or omit it so the user can select among connections owned by the trusted caller.

Unknown child actions fail with `400`.

## Public create-connection contract

The following existing request variants remain supported:

```json
{ "action": "create-connection", "labels": { "team": "payments" } }
```

```json
{
  "action": "create-connection",
  "scope": "database",
  "operation": "create",
  "database": "orders"
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

Unknown fields, incomplete access objects, invalid database names, non-string labels, and reserved
labels fail with `400`. Database-name validation preserves the existing documented rules.

If access is supplied, the approval dialog displays it read-only. A labels-only request lets the
user choose database or full access and all required details in the dialog.

The success value remains `RPC.CreateConnection`. Connection metadata retains:

- `host`, `port`, and selected database;
- generated username and password;
- the exact approved access discriminator;
- the complete runner-generated platform connection.

## Mandatory create approval

The create workflow is:

1. Read and validate trusted interface context and request metadata.
2. Load the PostgreSQL resource and relevant connections for the dialog.
3. Display the approval dialog.
4. If rejected or cancelled, close with `499` and perform no mutation.
5. If approved, reload the resource and connections to avoid acting on stale state.
6. If exactly one compatible connection already exists, return it without starting a run.
7. If the existing state conflicts or is ambiguous, fail with `409`.
8. Otherwise generate credentials, build the runner plan, start the run, and track it by events.
9. After success, reload and return the newly created connection.

Approval is required even when step 6 returns an already-existing compatible connection. No call to
`caller.start`, connection creation, or successful `wire.close` may occur before approval.

The request identity remains compatible with the published guide:

- trusted calling-manager ID;
- PostgreSQL resource ID;
- database versus full scope;
- database name for database scope;
- superuser choice for full scope.

Database operation and caller labels are compatibility checks, not identity dimensions. Multiple
exact matches or incompatible matches fail with `409` rather than being selected arbitrarily.

## Provisioning runner plan

Provisioning is one normal Deploy Commander run using
`ezenki/deploy-commander-runner:latest`. Its metadata contains:

1. a `postgres:15` runner-role service that consumes the resource's exact platform connection and
   performs the required `psql` work; and
2. a top-level connection-create plan for the trusted caller, resource ID, connection metadata, and
   labels.

The runner executes the runner-role service before the top-level connection creation. No object
database hooks or Deploy Commander `databaseQuery` calls are used.

Generated PostgreSQL role names are deterministic for the request identity. Passwords remain random.
Provisioning SQL is idempotent: retry may create or update that role without a cleanup history. A
database-create retry accepts an existing database only when it is owned by the deterministic role;
an unrelated name collision fails safely with `409`. Existing-database access verifies that the
database exists before granting access.

Operational `psql` inspection during a provisioning run is allowed because it is required to execute
SQL safely. It is not used as manager state and is not a catalog mirror.

## Public delete-connection contract

Existing delete requests remain supported:

```json
{ "action": "delete-connection", "connection": "connection-id" }
```

```json
{ "action": "delete-connection" }
```

Only connections owned by the trusted calling manager are selectable. A missing or inaccessible
specified ID produces the same `404`. Success remains:

```json
{ "connection": "connection-id" }
```

## Mandatory delete approval and cleanup

The delete workflow is:

1. Load the installed resource and all visible connections attached to it.
2. Restrict candidates to the trusted calling manager.
3. Display the requested or selectable target and its cleanup consequence.
4. If rejected or cancelled, close with `499` and perform no mutation.
5. If approved, reload the target and resource connections.
6. Fail with `409` if the target or its cleanup consequence changed.
7. Derive cleanup from connection labels.
8. Start and track one cleanup run.
9. After success, verify that the connection is absent and return its ID.

The runner plan performs idempotent PostgreSQL cleanup first and then includes the exact connection
ID and resource ID in the runner's top-level connection-remove plan.

Cleanup is determined as follows:

| Target | Other same-database connections | PostgreSQL cleanup |
| --- | --- | --- |
| Full access | any | Delete generated role only |
| Existing database | any | Delete generated role only |
| Managed database | one or more | Delete generated role only |
| Managed database | none | Delete database and generated role |

Only `postgres.database-origin=managed` permits database deletion. Unknown, missing, or contradictory
reserved labels fail with `409` and preserve the database. Role and database cleanup use idempotent
`IF EXISTS` behavior, so a retry does not need durable cleanup history.

## Installation and teardown plans

### Install

The Install button immediately starts a standard create run containing:

- service key and alias `postgres`;
- image `postgres:15`;
- persistent `postgres-data` volume mounted at `/var/lib/postgresql/data`;
- one produced resource of type and name `postgres`;
- generated administrator credentials in resource configuration.

The resource's runner-generated platform connection is consumed unchanged by later one-time
PostgreSQL client services and returned unchanged to connection consumers.

### Uninstall

After explicit confirmation, uninstall starts the runner's supported full teardown action. The UI
does not manually reproduce teardown with guessed Docker names. On success it reloads resources and
connections and shows Not installed because the resource no longer exists.

## Run-event tracker

One wire and event subscription exist for the application lifetime. Starting an operation follows
this sequence:

1. Set local UI phase to `starting` immediately.
2. Generate a unique, credential-free correlation note.
3. Begin buffering matching `run-start` and `run-update` events.
4. Call the options-object `caller.start({ ... })` API.
5. Bind to the returned run ID.
6. If `run-start` arrived first, bind its ID by the exact action and note.
7. If both sources provide IDs, require them to agree.
8. Apply only structured run events whose payload ID matches the bound run.
9. Import and use the package's official queued/running/done/failed constants.
10. On a terminal event, verify the exact run with `getRun(runId)` and refresh durable projections.

For a known run ID, exact `getRun`, `getRunEvents`, or `getRunUpdates` calls may catch up after a
missed live event. No latest-run or completed-history query is permitted.

If `caller.start` fails and no matching live `run-start` was observed, report that the operation
could not be started. Do not search history and do not show recovery.

## UI states

Connection workflows use this visible progression:

```text
awaiting approval -> starting -> queued/running -> completed | failed
```

The application cannot render `starting`, “Preparing PostgreSQL connection,” or any equivalent
operational state before an approval decision. Rejecting an approval closes the child request with
`499`.

Errors use concrete language and provide a deliberate retry action where safe. There is no Recovery
panel, Recovery Required dialog, or recovery call to action.

## Error contract

| Status | Meaning |
| --- | --- |
| `400` | Invalid request/context, invalid approved access, or invalid required resource configuration |
| `404` | PostgreSQL not installed, existing database absent, or connection unavailable |
| `409` | Active mutation, resource conflict, connection conflict, changed deletion consequence, or database collision |
| `499` | User rejected or cancelled approval |
| `500` | Runner or PostgreSQL operation failed |

The manager does not expose a recovery-specific `503`.

## Documentation changes

Rewrite `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md` into one consistent public contract:

- preserve all supported request variants and successful result shapes;
- require an existing PostgreSQL resource;
- document mandatory create and delete approval;
- document the three reserved labels and final-managed-connection deletion rule;
- explain event-driven operation progress;
- remove automatic-install language;
- remove catalog, `databaseQuery`, recovery, cleanup-history, and `503` instructions;
- explain retry behavior in terms of idempotent SQL and current resources/connections.

## Testing strategy

### Domain tests

- strict request parsing and database-name validation;
- reserved-label rejection and generated-label output;
- resource projection for zero, one, and multiple matches;
- exact connection matching and compatibility conflicts;
- managed-origin propagation for existing-database requests;
- deletion consequence for full, existing, shared managed, and final managed access.

### Workflow tests

- create and delete do not start a run or mutate before approval;
- rejection returns `499` with zero side effects;
- exact existing create requests still require approval;
- resource and connection state is refreshed after approval;
- changed deletion consequences fail safely;
- install starts directly from its button;
- uninstall requires confirmation;
- runner plans contain supported resource, runner-service, connection-create, connection-remove, and
  teardown shapes;
- no plan contains object database hooks.

### Run tracker tests

- local `starting` precedes the start call;
- `run-start` may arrive before or after the start response;
- mismatched IDs fail explicitly;
- unrelated events are ignored;
- queued, running, done, and failed transitions use official constants;
- exact-run catch-up works without latest-run/history lookup;
- cleanup disposes listeners and timers.

### React tests

- root dashboard installation projections;
- create proposal is read-only and labels-only requests are configurable;
- create and delete approval dialogs are visible before progress;
- cancel and reject behavior;
- progress and concrete error rendering;
- successful child close response shapes.

## Acceptance criteria

1. Production source contains no `databaseQuery`, `getLatestRun`, recovery state, recovery class, or
   “recovery required” message.
2. PostgreSQL installation display depends only on matching resources.
3. Logical access and database-deletion decisions depend only on current connections and labels.
4. No create/delete mutation or run begins before explicit approval.
5. Install begins directly from the Install button without a second prompt.
6. Run progress is driven by `run-start` and `run-update` for the exact operation.
7. Only the final connection to a manager-created database can drop that database.
8. Existing child-interface request variants and successful response shapes remain compatible.
9. `npm test`, `npm run lint`, `npm run build`, and `npm run format:check` pass.
10. The official React/TypeScript scaffold and manager publishing configuration are present.
