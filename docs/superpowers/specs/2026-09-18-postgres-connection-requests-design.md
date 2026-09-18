# PostgreSQL Connection Requests Design

## Summary

Extend the PostgreSQL manager so another manager can request one new database,
request broad access to one existing database, request full installation access,
or leave all non-label choices to the user. Every request requires explicit user
approval. Approved connections are created by the standard Deploy Commander
runner with initial labels, and database names are also recorded in the
PostgreSQL manager's Deploy Commander database through runner object hooks.

This change continues to use `ezenki/deploy-commander-runner:latest` as the
top-level runner and the regular PostgreSQL image for PostgreSQL operations. It
does not add a custom runner image or modify the runner contract.

## Goals

- Let a calling manager optionally propose a complete database or full-access
  request.
- Let a calling manager omit all non-label specifics so the user configures the
  connection.
- Require explicit approval or rejection for every request.
- Let one calling manager own multiple PostgreSQL connections for the same
  PostgreSQL resource.
- Support creating a new database, accessing an existing database, constrained
  full access, and dedicated-superuser access.
- Accept optional caller-supplied labels on the created connection.
- Add authoritative PostgreSQL scope labels without allowing caller conflicts.
- Record database names in the manager database without duplicating full
  Deploy Commander connection state.
- Use the corrected standard-runner metadata contract for connection creation
  and manager-database object hooks.
- Add Prettier and improve the readability and boundaries of touched code.
- Update `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md` to document the
  complete consumer contract.

## Non-goals

- Creating a custom PostgreSQL runner image.
- Changing the Deploy Commander runner or its documented metadata contract.
- Letting callers provide usernames, passwords, resource IDs, manager IDs,
  hostnames, ports, platform connections, or SQL.
- Letting the manager database replace Deploy Commander connections as the
  authority for connection existence or credentials.
- Adding an individual connection-deletion child-interface action.
- Automatically discovering databases created outside this manager's
  workflows. The catalog records databases observed through approved access
  workflows; PostgreSQL remains authoritative for existence.
- Adding a separate human-facing connection display name.

## Authoritative Contracts

Implementation must follow:

- `docs/integrations/DEPLOY_COMMANDER_RUNNER_INTERFACE_GUIDE.md`
- `docs/integrations/MANAGER_INTERFACE_GUIDE.md`
- `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md`
- The installed `@ezenki/deploy-commander-installer-interface` types

The standard runner's documented `connections.create`, connection `name`,
connection labels, and `object_hooks` fields are sufficient. Undocumented
metadata fields must not be invented.

## Child Interface Metadata

The child interface metadata is the request. There is no nested `request`
property.

```ts
type PostgresInterfaceMetadata =
  | {
      action: "create-connection";
      labels?: Record<string, string>;
    }
  | {
      action: "create-connection";
      scope: "database";
      operation: "create" | "existing";
      database: string;
      labels?: Record<string, string>;
    }
  | {
      action: "create-connection";
      scope: "full";
      superuser: boolean;
      labels?: Record<string, string>;
    };
```

The object must match exactly one variant. Unknown fields, partial scoped
requests, non-string labels, invalid database names, and reserved-label
conflicts are rejected. Trusted calling-manager identity continues to come
only from Deploy Commander.

The metadata-only variant delegates all non-label choices to the user. A
complete scoped variant is displayed read-only and may only be approved or
rejected.

### Database name validation

Database names must be non-empty, contain no NUL byte, and fit PostgreSQL's
63-byte identifier limit when UTF-8 encoded. SQL always treats them as data and
quotes them as identifiers through `psql` variables and PostgreSQL formatting
functions. `template0` and `template1` cannot be selected. A generated database
name uses the existing `db_<32 lowercase hexadecimal characters>` form and is
shown to the user before approval.

### Label validation

Label keys are trimmed and must be non-empty. Values must be strings and may be
empty. The following keys are reserved:

- `postgres.access`
- `postgres.database`

A caller-supplied reserved key is a validation error, even when its value would
match the manager-generated value.

## Approval Experience

Every child request reaches an approval decision. There is no remembered
approval bypass.

For a complete manager request, the approval UI shows:

- Trusted calling-manager identity
- Database or full-access scope
- New or existing database operation where applicable
- Database name where applicable
- Constrained or superuser privilege level for full access
- Caller-supplied labels
- Whether PostgreSQL must first be installed

The values are read-only. The user approves or rejects the request as a unit.

For metadata without specifics, the UI lets the user choose:

- Create a new database, with manual name entry or UUID-based generation
- Access an existing database, with catalog selection or manual name entry
- Full access, with constrained or superuser privileges

The UI displays caller labels read-only and shows the final generated database
name before approval. A superuser choice includes a prominent warning. The
approval control remains disabled until the configuration is valid.

The existing local-storage permission preference, "remember" control, and
dashboard reset action are removed. Browser storage is not an authorization
mechanism and no longer affects connection approval.

## Connection Identity and Cardinality

One calling manager may have multiple non-external connections to the same
PostgreSQL resource. A request identity is:

```text
(calling manager, PostgreSQL resource, access scope, database name, superuser)
```

- `database name` participates only for database scope.
- `superuser` participates only for full scope.
- Generated credentials and caller labels do not define identity.

At most one connection may exist for one identity. An exact repeat may return
the existing connection, but the user must still approve the request first.
The existing connection's approved labels must agree with the requested labels;
otherwise the workflow returns a conflict instead of silently mutating labels
or creating a duplicate.

The implementation must stop treating `(manager, resource)` as globally unique.
Connection lookup must enumerate or filter authorized connections and validate
full metadata before selecting an exact identity. Ambiguous or contradictory
records require recovery rather than best-effort selection.

## Access Modes

Every approved connection receives a newly generated dedicated login and
password. Caller-provided credentials are never accepted.

### New database

- Reject the request if the database already exists.
- Create the dedicated login with no server-wide administrative attributes.
- Create the database with the dedicated login as owner.
- Revoke inappropriate public privileges and grant the login the expected
  database and public-schema privileges.
- Never alter the owner of a colliding database.

The current create-if-absent followed by unconditional owner alteration is
removed because it can take ownership of an existing database.

### Existing database

- Reject the request if the database does not exist or is a template database.
- Create a dedicated non-owner login.
- Grant broad database-local access without changing database ownership.
- Cover current non-system schemas, tables, sequences, functions/routines, and
  appropriate default privileges where PostgreSQL permits.
- Do not grant server-wide role-management, replication, bypass-RLS, or
  superuser privileges.

Compensation for a failed existing-database connection drops only the new login
and its grants. It never drops or changes ownership of the database.

### Constrained full access

- Create a dedicated login with `CREATEDB`.
- Grant broad database-local access across current non-template databases.
- Do not grant `SUPERUSER`, `CREATEROLE`, replication, or bypass-RLS.
- Document that databases later created by unrelated owners may require a later
  approved grant workflow; this mode is intentionally less powerful than
  superuser.

### Superuser access

- Create a dedicated login with PostgreSQL `SUPERUSER`.
- Require an explicit request or explicit user configuration and a prominent
  approval warning.
- Keep the installation's primary administrator credential private; the
  dedicated superuser can be revoked independently.

## Connection Metadata and Labels

Connection metadata retains the usable connection configuration:

```ts
interface PostgresConnectionMetadata {
  host: "postgres";
  port: 5432;
  database: string;
  username: string;
  password: string;
  access: {
    scope: "database" | "full";
    operation?: "create" | "existing";
    superuser?: boolean;
  };
  platform_connection: PlatformConnection;
}
```

For full access, `database` is `postgres`, the default login database; it does
not imply database-scoped access.

The final connection labels are:

```text
caller labels
+ postgres.access=database|full
+ postgres.database=<database name>  # database scope only
```

The labels are supplied in the runner's connection-create specification so
they are initial connection labels, not connection metadata and not a later
best-effort mutation.

## Standard Runner Plan

Continue to use the standard top-level runner and regular PostgreSQL image.
For an already installed PostgreSQL resource, an access run contains:

1. A stable runner-role PostgreSQL service that executes a fixed provisioning
   or grant program with generated credentials and approved values passed as
   environment variables.
2. A top-level `connections.create` entry containing:
   - Runner-only `name: "postgres-connection"`
   - Trusted calling manager
   - Existing PostgreSQL resource UUID
   - Connection metadata
   - Final initial labels
3. For database scope, a connection object hook selected by the same
   `postgres-connection` name.

The runner-only connection name exists solely to select the hook and format
events. It is not sent to the agent, stored as a display name, or treated as a
global identifier.

The current separate frontend `caller.createConnection(...)` call is removed.
After the run completes, the frontend resolves and validates the exact created
connection before returning it through `wire.close`.

When PostgreSQL is absent, the existing installation run completes first
because the standard runner currently requires an existing resource UUID for a
connection create. The access run uses the refreshed authoritative resource and
platform connection.

## Manager Database Catalog

The manager database stores a credential-free PostgreSQL database inventory.
It supplements rather than replaces Deploy Commander resources and
connections.

Each database record contains at least:

- PostgreSQL resource UUID
- Database name
- Origin: manager-created or pre-existing
- Stable creation/update timestamps managed by the database query

The stable identity is `(resource UUID, database name)`, enforced by a unique
index or deterministic record identity. Upserts must preserve a
manager-created origin rather than downgrade it to pre-existing.

The catalog does not store:

- Passwords or administrator credentials
- Full connection metadata
- A guessed connection UUID
- Authorization decisions

For database-scoped access, the runner uses the connection hook's
`create.before` query to initialize schema/indexes if needed and idempotently
upsert the database record. Runner service setup has already verified or
created the PostgreSQL database at that point. A catalog failure prevents
connection publication.

The hook cannot consume the newly generated connection UUID, and the design
does not pretend otherwise. Later code can link catalog records to connections
through the authoritative resource plus the `postgres.database` and
`postgres.access` labels.

If a newly created database must be compensated after catalog insertion, the
cleanup run removes the database and role and uses a successful cleanup
runner-container hook to remove the corresponding catalog record. Cleanup of
an existing-database or full-access attempt removes only the dedicated role and
does not remove a database catalog record.

Catalog entries are selectable hints. The access runner always verifies actual
PostgreSQL existence/nonexistence before applying grants or creation, so stale
catalog state cannot authorize or redirect an operation.

## Workflow and Recovery

The connection workflow is:

1. Read and strictly validate interface metadata.
2. Resolve the trusted current and calling managers.
3. Gather the user's configuration when metadata contains no specifics.
4. Show the complete approval decision and require approve or reject.
5. Install PostgreSQL if absent and the approved workflow can proceed.
6. Refresh the authoritative resource and platform connection.
7. Find an exact existing connection identity.
8. Return an agreed exact connection or reject conflicting duplicates.
9. Generate dedicated credentials and an operation identity.
10. Build and start the standard-runner plan.
11. Wait for terminal run state.
12. Resolve and fully validate the exact created connection.
13. Compensate mode-appropriately when provisioning succeeded but connection
    publication did not.
14. Close the child interface exactly once with the normalized result.

Run notes and configuration retain only the recovery data already required by
the run-backed workflow. Secrets must not be copied to notes, labels, catalog
records, logs, browser storage, URLs, or error messages. Any recovery parsing
must validate the approved access mode as well as the calling manager,
resource, database, and generated role.

Redelivery and ambiguous transport outcomes are reconciled through exact run
and connection identity. Manager-database hooks use fixed query text, bound
values, stable identities, transactions where supported, `IF NOT EXISTS`, and
idempotent `UPSERT`. The code must inspect every returned database statement
status as required by the runner contract.

## Errors

Child-interface failures remain normalized and non-secret:

| Status | Meaning |
| --- | --- |
| `400` | Invalid metadata, invalid labels, invalid database name, or missing calling manager |
| `404` | Requested existing database does not exist |
| `409` | Another operation is active, a requested new database already exists, or an exact identity conflicts with existing labels/configuration |
| `499` | User rejected or cancelled the request |
| `503` | Installation, resource, connection, or prior-run state requires recovery |
| `500` | Unexpected provisioning, persistence, or reconciliation failure |

Internal PostgreSQL, Docker, credential, SQL, and backend error details are not
returned to the caller.

## Code Structure

The current flow contains several high-complexity functions. Changes should
split touched responsibilities into focused units rather than expanding those
functions further:

- Metadata parsing and validation
- Approved access-request domain types and identity
- Runner plan construction for each access mode
- PostgreSQL fixed programs and mode-specific cleanup
- Exact connection lookup and normalization
- Run recovery/reconciliation
- Database catalog hook construction
- Request review/configuration UI

Existing repository patterns should be retained outside this scope. Do not
perform unrelated refactoring.

## Formatting

Add Prettier as a development dependency with repository configuration and
ignore rules. Add `format` and `format:check` scripts. Format the PostgreSQL
interface source, tests, relevant configuration, and
`docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md`.

Prettier complements rather than replaces ESLint and TypeScript checks.

## Documentation

Rewrite the PostgreSQL manager interface guide where necessary to cover:

- All three metadata variants
- Caller label rules and reserved labels
- Mandatory approval with no remembered bypass
- User-configured new, existing, constrained-full, and superuser requests
- Generated database names
- Multiple connections per manager/resource
- Connection identity and duplicate behavior
- Returned access metadata and labels
- Database catalog semantics and limitations
- Retry, recovery, compensation, and normalized errors
- Consumer runner-plan examples and secret handling

The guide must no longer claim that only `{ action: "create-connection" }` is
accepted or that only one connection may exist per manager/resource.

## Testing and Verification

Use test-driven development for implementation.

Unit and component coverage must include:

- Every valid metadata variant
- Unknown, partial, and malformed metadata rejection
- Caller labels and reserved-label conflicts
- Mandatory approval for new and duplicate requests
- User configuration and UUID database-name generation
- Read-only rendering of manager-supplied specifics
- Superuser warning
- Multiple exact connection identities per manager/resource
- Conflicting duplicate labels/configuration
- Runner connection plan and fixed hook selector
- Initial connection labels
- Idempotent catalog hook query and bindings
- Mode-specific provisioning and compensation plans
- Exact post-run connection resolution
- Ambiguous-run recovery and non-secret errors

PostgreSQL integration coverage must include:

- New database creation and collision rejection without ownership change
- Existing database broad local grants without ownership change
- Constrained full access and prohibited attributes
- Dedicated superuser access
- Generated credential secrecy in output
- New-database compensation
- Existing/full compensation that preserves databases
- Idempotent catalog-related retry behavior where the runner boundary can be
  exercised with fakes

Final verification commands include:

- Prettier check
- ESLint
- All Vitest tests
- TypeScript/Vite production build
- Opt-in Docker/PostgreSQL integration tests when Docker is available

## Best-Practice Findings Addressed

- Prevent ownership takeover on database-name collision.
- Remove cross-request remembered approval.
- Replace one-connection-per-manager/resource assumptions.
- Use the runner's documented connection plan, initial labels, and object hooks.
- Keep manager database state supplemental and credential-free.
- Keep the runner token out of PostgreSQL service containers.
- Avoid arbitrary caller SQL and interpolate no untrusted identifiers.
- Split high-complexity touched workflows into focused units.
- Add deterministic formatting and a format check.

The existing test, lint, and build suites passed before implementation; this
provides the behavioral baseline for the change.
