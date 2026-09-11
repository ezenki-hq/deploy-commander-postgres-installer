# PostgreSQL Run-Backed State Design

## Goal

Remove the PostgreSQL manager's SurrealDB dependency. Deploy Commander runs,
resources, and connections become the manager's only durable records:

- The latest run's action and status determine PostgreSQL lifecycle state.
- The owned PostgreSQL resource stores administrator credentials and platform
  configuration.
- Deploy Commander connections store consumer-specific logical credentials.
- Run records provide reload and failure recovery for connection provisioning
  and cleanup.

The change also lets a connection request install PostgreSQL when it is absent.
The user must approve that side effect before installation starts. Installation
must complete successfully before the connection provisioning run is started.

## Confirmed Platform Assumption

Deploy Commander serializes every operation for a manager, including child
connection requests. The PostgreSQL manager therefore does not need its own
database-backed mutual-exclusion lock.

This guarantee is a prerequisite for this design. If the platform later permits
concurrent operations for one manager, the platform must provide an equivalent
serialization or idempotency boundary before that behavior is enabled.

## Sources of Truth

Deploy Commander owns all persistent state used by the manager:

1. **Runs** own operation action, status, runner input, and non-secret operation
   correlation notes.
2. **The PostgreSQL resource** owns installation configuration, including the
   administrator credentials and runner-generated platform connection.
3. **Connections** own each consuming manager's logical database credentials
   and platform connection.
4. **Browser local storage** remains only a convenience for installation-scoped
   remembered approval. It is not an authorization or lifecycle source.

The manager must not call `databaseQuery`. The `postgres_state` and
`postgres_operation` tables, database bootstrap, primary-state accessors,
operation journal, and manager-database integration harness are removed.

Resource lookup validates whether the installation can be operated on, but it
does not silently override run-derived lifecycle state. A contradiction between
the latest run and resources is an explicit attention state.

## Run Contract

The manager retrieves exactly the newest run with an explicit newest-first sort
and a limit of one. It validates the result envelope, run identifier, action,
status, and ordering fields before resolving lifecycle state.

Run status values remain:

- `0`: queued.
- `1`: running.
- `2`: done.
- `3`: failed.

The latest-run lifecycle matrix is:

| Latest action | Status `0` or `1` | Status `2` | Status `3` |
| --- | --- | --- | --- |
| `create` | Installing | Installed | Installation failed; install is retryable |
| `teardown` | Tearing down | Not installed | Teardown failed; PostgreSQL remains installed |
| `create-connection` | Installed; manager operation busy | Installed | Installed |
| `cleanup-connection` | Installed; manager operation busy | Installed | Installed |
| No run | Not installed | Not installed | Not installed |

An unknown action, unsupported status, or malformed run response is not guessed
at. The manager fails closed with a fixed startup error.

Run events trigger a refresh of this authoritative latest-run view. Directly
started workflows continue to wait for their exact returned run ID, using
`getRun(id)` as the fallback when an event is missed.

## PostgreSQL Resource Contract

New installations publish one non-external resource with the stable identity:

```text
type: postgres
name: postgres
```

Its metadata contains engine/version information and a nested administrator
credential object. The conceptual shape is:

```ts
interface PostgresResourceMetadata {
  engine: "postgres";
  version: "15";
  administrator: {
    username: string;
    password: string;
  };
}
```

The implementation must validate the complete metadata required for an
operation. Administrator username and password must be nonblank, the username
must satisfy PostgreSQL identifier constraints, and malformed or missing
metadata must fail closed.

`getResource(id)` is owner-scoped and returns the full resource configuration.
The PostgreSQL manager may read administrator credentials from it. Credentials
must not be rendered, logged, placed in run notes, copied into consumer
connection metadata, stored in browser storage, or returned in public errors.
They necessarily remain in the access-controlled runner configurations that use
them.

The runner-generated `platform_connection` stays separate from resource
metadata and is validated from the resource configuration before provisioning
or returning a consumer connection.

## Dashboard Boot and Actions

Dashboard boot does not initialize storage or run database recovery. It:

1. Resolves the current manager identity and interface mode.
2. Fetches and validates the latest run.
3. Resolves the explicit lifecycle state from the matrix.
4. Counts exact owned PostgreSQL resources and, when needed, loads the single
   resource configuration.
5. Presents the lifecycle state or a contradiction/compatibility warning.

Before starting an action, the manager re-reads the latest run and exact resource
count to protect against a stale React view.

Installation is allowed only when the run-derived state is not installed or
active and no exact PostgreSQL resource exists. It generates administrator
credentials, embeds them in both the PostgreSQL environment and resource
metadata, starts action `create`, and waits for the exact run to finish. Status
`3` produces a fixed installation-failed result and permits a later retry.

Teardown is available for installed, failed-teardown, contradictory, and legacy
resource states. It starts action `teardown` and does not depend on administrator
credentials. Status `3` preserves the installed/failed-teardown presentation;
status `2` resolves to not installed. Remembered approval remains scoped to the
old resource ID, so a stale key cannot authorize a later installation with a
different resource ID.

Multiple exact resources always produce an attention state. A resource found
when run state says PostgreSQL is absent, or a missing resource when run state
says it is installed, also produces an attention state rather than automatically
starting a potentially destructive correction.

## Connection Request With Automatic Installation

A child interface continues to accept only exact metadata:

```json
{ "action": "create-connection" }
```

The caller identity comes only from Deploy Commander's trusted calling-manager
context.

The workflow is:

1. Validate the current manager and calling manager.
2. Count exact owned PostgreSQL resources.
3. If one valid resource exists, look for an existing connection for the trusted
   caller and return it without prompting or provisioning.
4. If no resource exists and run-derived state safely permits installation,
   show an approval dialog explaining that approval will install PostgreSQL and
   create a logical database.
5. If the user cancels, close with the existing cancellation response and start
   no run.
6. If approved, run PostgreSQL installation and wait for confirmed status `2`.
   A failed or uncertain installation never starts `create-connection`.
7. Fetch the newly created exact resource and validate its administrator
   metadata and platform connection.
8. If the user selected remembered approval, store it now under the newly known
   resource ID.
9. Generate logical credentials, start `create-connection`, wait for status `2`,
   create the Deploy Commander connection, and return it through the child wire.

When a valid resource already exists, the existing resource-scoped remembered
approval behavior is preserved. Duplicate detection remains before the prompt
and before connection persistence.

## Run-Backed Connection Recovery

Provisioning and cleanup runs use versioned, non-secret notes that identify:

- The operation kind.
- A random operation ID.
- The trusted calling manager ID.
- The PostgreSQL resource ID.

Identifiers must be encoded and parsed unambiguously. Passwords never appear in
notes. Full runner configurations are retrieved only with `getRun(id)` and are
strictly validated before recovery uses their service environment.

The provisioning run configuration durably contains the generated logical
database, username, and password because those values are already required by
the runner. This allows a later invocation to finish connection persistence
after a reload without a separate journal.

Before starting new provisioning, a child invocation reconciles the latest
connection operation:

- A queued or running `create-connection` run is awaited; a second provisioning
  run is not started.
- A successful `create-connection` run is matched to a valid existing connection.
  If the connection is absent, the manager completes persistence using the
  validated run configuration.
- If connection persistence has an ambiguous response, the manager checks
  existing connections before deciding whether cleanup is required.
- A failed provisioning run, or a conclusively unpersisted provisioned database,
  starts an idempotent `cleanup-connection` run for that exact generated database
  and username.
- A queued or running cleanup run is awaited.
- A successful cleanup permits a fresh request.
- A failed cleanup is retried deliberately and is never treated as successful.
- An operation belonging to a different caller is reconciled for its recorded
  trusted caller before the new caller is serviced.

The cleanup run configuration contains the exact database and username needed
to resume cleanup. Administrator credentials are re-read from the current owned
resource rather than trusted from historical input when a new recovery run is
constructed.

Run-start ambiguity is handled with exact action/note correlation. An accepted
run is monitored; a second run starts only when exhaustive lookup proves the
first was not accepted. Deploy Commander serialization prevents the check/start
race that the deleted application-level journal previously guarded.

## Existing Installations

Resources created by the current implementation contain no administrator
credentials, and the installer interface has no resource-update RPC. The new
implementation does not retain a one-time database migration path.

An existing resource without valid administrator metadata is incompatible:

- It is not eligible for new logical connection provisioning.
- The dashboard clearly requires teardown and reinstall.
- Teardown remains available without administrator credentials.
- The next successful install creates the new resource metadata contract.

This is an intentional migration boundary.

## Error and Security Behavior

External errors remain fixed and non-secret. Transport errors, run
configuration contents, resource metadata, platform data, PostgreSQL output, and
credentials are never returned through the child wire or general dashboard.

Expected classifications remain:

- Missing calling manager: `400`.
- Manager operation already queued/running: `409`.
- User cancellation: `499`.
- Contradictory, malformed, or incompatible installation/recovery state: `503`.
- Confirmed workflow failure or normalized unexpected failure: `500`.

Abort stops local monitoring and UI work but does not reinterpret the durable run
outcome. A later invocation reconciles the latest run.

## Code Organization

The implementation should introduce focused modules for:

- Latest-run validation and lifecycle resolution.
- PostgreSQL resource metadata/configuration validation.
- Run-note encoding/parsing and connection-operation recovery.

Installation and teardown orchestration remain together if the resulting module
stays focused. App and dashboard props use explicit lifecycle state rather than
database-backed `PrimaryState` phases.

The following database-oriented implementation is removed or replaced:

- Manager database bootstrap.
- Primary-state persistence.
- Operation-journal persistence.
- Database-backed installation/teardown recovery.
- Database-backed connection recovery.
- Manager-database test helpers and integration harness.
- Documentation that describes SurrealDB as required PostgreSQL manager state.

Unrelated runner, connection ownership, platform connection, permission, and UI
contracts remain unchanged.

## Testing and Verification

Use test-driven development for each behavior change. Coverage includes:

- Every supported action/status combination in the latest-run matrix.
- No-run, malformed-page, malformed-run, unsupported-status, and unknown-action
  behavior.
- Refresh after run events and protection against stale action views.
- Administrator credentials in install resource metadata and their absence from
  rendered output, notes, errors, and consumer connection metadata.
- Exact resource/config validation and multiple-resource contradictions.
- Approval before automatic installation.
- Strict `create` completion before `create-connection` starts.
- Install failure or ambiguity preventing connection provisioning.
- Remembered approval being stored only after the new resource ID exists.
- Duplicate connection return without prompting or provisioning.
- Provisioning and cleanup recovery for queued, running, done, and failed runs.
- Reload between provisioning completion and connection persistence.
- Ambiguous connection persistence followed by authoritative duplicate lookup.
- Prior-operation reconciliation across different calling managers.
- Existing credential-less resources requiring teardown/reinstall.
- Installation and teardown retry behavior.
- A repository scan proving production code makes no `databaseQuery` call.

Final verification runs focused tests during implementation, then the complete
test suite, ESLint, and the production build.

## Out of Scope

- Changing Deploy Commander run status values or runner action names.
- Adding a resource-update RPC solely to migrate old installations.
- Encrypting resource metadata independently of Deploy Commander's owner-scoped
  resource configuration.
- Supporting concurrent operations for one PostgreSQL manager.
- Changing consumer connection metadata or its platform handoff contract.
- Changing PostgreSQL major version, service name, volume name, resource type,
  or resource name.
