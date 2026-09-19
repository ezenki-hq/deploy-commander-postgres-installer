# PostgreSQL Delete Connection Design

**Date:** 2026-09-19

## Purpose

Add a caller-facing PostgreSQL manager action named `delete-connection`.
A calling manager may identify one connection to delete, or omit the connection
identifier and let the user select from that calling manager's connections.
The workflow must never delete a connection owned by another manager.

Deleting a connection removes the generated PostgreSQL role. It also removes
the database only when that connection originally created the database.
Pre-existing databases and databases reached through full access remain in
place.

## Request and Response Contract

The parent manager invokes the child interface with one of these exact metadata
objects:

```json
{ "action": "delete-connection" }
```

```json
{ "action": "delete-connection", "connection": "<connection-id>" }
```

`connection` must be a nonblank string when present. The parser rejects blank
identifiers, extra properties, alternate ownership fields, and malformed
values. No caller identity or resource identity is accepted from request
metadata.

The current PostgreSQL manager comes from `getManager()`. The trusted calling
manager comes from `getCallingManager()`. A missing, blank, or malformed calling
manager fails before connection discovery or runner work begins.

A successful workflow closes with a non-secret result:

```json
{ "connection": "<deleted-connection-id>" }
```

## Public and Internal Actions

`delete-connection` is the public manager-interface action and the request
metadata discriminator. PostgreSQL cleanup continues to use the existing
internal runner action `cleanup-connection`. This preserves one validated,
idempotent cleanup plan for create-workflow compensation and explicit
connection deletion.

Installation lifecycle and connection lifecycle remain separate. A deletion
request must not change whether the manager dashboard considers PostgreSQL
installed.

## Application Routing and Components

`App.tsx` recognizes three modes:

1. Exact `create-connection` metadata selects the existing create workflow.
2. Exact `delete-connection` metadata selects the new delete workflow.
3. Other metadata selects the normal manager dashboard, preserving the current
   behavior for unrelated host metadata.

The delete view retains the parsed request and trusted calling-manager identity
across run events, just as the create view does. Run refreshes must not restart
the child workflow or return it to the dashboard.

A focused `DeleteConnectionRequest` component owns presentation and child-wire
lifecycle. It displays loading, selection, confirmation, busy, and safe error
states; adapts user decisions to the workflow; aborts local monitoring on
unmount; and closes the wire at most once. It does not authorize connections or
construct runner metadata.

Deletion orchestration belongs in a separate library workflow. Connection
enumeration and normalization belong with the existing connection contract
helpers. Cleanup plan construction and run parsing continue to live with the
existing plan and run modules.

## Authoritative Installation and Connection Discovery

Before listing or resolving connections, the workflow reads the single
installed PostgreSQL resource and validates its administrator credentials and
platform connection through the existing resource contract. Missing,
ambiguous, contradictory, or incompatible installation state requires
recovery; deletion never installs PostgreSQL automatically.

Connection queries always include both:

- `manager: callingManagerId`
- `resource: postgresResourceId`

Queries use bounded pagination, stable totals, duplicate-ID rejection, and
included labels. Every summary must identify the expected calling manager and
PostgreSQL resource. The workflow then fetches and validates every candidate's
full connection record before exposing it to the user.

An eligible connection must have all of the following:

- Matching summary and configuration IDs.
- `connection.manager` and `config.manager` equal to the trusted calling
  manager.
- `connection.resource` and `config.resource` equal to the authoritative
  PostgreSQL resource.
- A non-external connection.
- The established PostgreSQL host, port, database, generated username, and
  nonblank password contract.
- A valid `access` object and a database consistent with that access object.
- Reserved labels consistent between summary, full record, and access metadata.
- A platform connection matching the authoritative resource platform.

Malformed results fail closed. They are not silently displayed, skipped, or
treated as unrelated connections.

When a request supplies `connection`, the workflow resolves that exact ID and
then applies every ownership and PostgreSQL-contract check above. An absent,
inaccessible, or differently owned ID produces the same fixed not-found
response. This avoids disclosing whether another manager owns the identifier.

When no ID is supplied, the user can select only from the fully validated
eligible set. An empty set produces the documented not-found response.

## User Selection and Confirmation

Every deletion requires explicit confirmation. There is no remembered approval
for destructive actions.

For a caller-supplied connection, the dialog presents the single validated
target. Otherwise it presents radio-button choices and disables Delete until
one is selected. Each choice and the final consequence text contain only:

- Connection ID.
- Database name, or `full installation access`.
- Whether both database and user will be deleted, or only the user.

Passwords, administrator credentials, and raw backend details are never
rendered.

The dialog follows the established accessible modal behavior: an accessible
name and description, `aria-modal`, initial focus, trapped Tab navigation,
Escape and Cancel while cancellation is safe, restored focus after dismissal,
and destructive visual treatment. Submission is single-shot. Once cleanup
begins, controls are disabled and the dialog cannot be dismissed.

Cancellation closes with status `499` and starts no cleanup run or connection
deletion.

## Deletion Semantics

The connection's validated `access` metadata determines cleanup:

| Access | PostgreSQL effect | Catalog effect |
| --- | --- | --- |
| `{ scope: "database", operation: "create", database }` | Drop the database only when it is owned by the generated role, then remove the generated role | Remove the managed database catalog record |
| `{ scope: "database", operation: "existing", database }` | Preserve the database; reassign/drop role-owned objects and remove only the generated role | Preserve the pre-existing database catalog record |
| `{ scope: "full", superuser: false }` | Preserve every database and remove only the generated role | None |
| `{ scope: "full", superuser: true }` | Preserve every database and remove only the generated role | None |

The existing cleanup scripts remain the source of truth. Identifiers enter
through environment variables and psql `\getenv`; dynamic identifiers use
server-side `format('%I', ...)`. Scripts remain non-interactive, idempotent,
free of shell tracing, and emit only fixed non-secret errors.

The created-database script first disables new connections and terminates
sessions, but issues database destruction only when the target database is
owned by the generated role. Role-only cleanup enumerates accessible,
non-template databases, reassigns and drops role-owned objects, and drops the
role without issuing `DROP DATABASE`.

## Revalidation and Destructive Ordering

The workflow captures an approved connection snapshot containing its ID,
manager, resource, external flag, access definition, generated login,
normalized labels, and authoritative platform connection.

Immediately after approval and before runner discovery or start, it fetches the
connection again and requires an exact match to that snapshot. A changed owner,
resource, access definition, username, password, database, labels, platform, or
external flag stops the workflow with a conflict response and without cleanup.

The destructive sequence is fixed:

1. Validate installation and resolve eligible connection(s).
2. Obtain explicit user confirmation.
3. Re-read and exactly revalidate the approved connection.
4. Reconcile or start PostgreSQL cleanup and wait for confirmed success.
5. Re-read and exactly revalidate the connection again.
6. Call `deleteConnection(connectionId)`.
7. Close successfully with the deleted connection ID.

The Deploy Commander connection record is never deleted before confirmed
PostgreSQL cleanup. Retaining it preserves the credentials and access metadata
needed for retry and diagnosis.

## Cleanup Run Recovery

Cleanup state is derived only from validated Deploy Commander runs and the
connection record. The feature adds no browser persistence, manager-database
journal, or parallel lifecycle store.

Before starting a cleanup run, the workflow exhaustively inspects relevant
`cleanup-connection` runs. It parses each candidate through the existing strict
run contract and identifies the target using the trusted caller, resource,
generated username, and complete access definition. Platform and cleanup-plan
metadata must also validate.

Recovery rules are:

- No matching run: create a fresh operation ID, start one cleanup run with the
  existing versioned note protocol, reconcile an ambiguous start response, and
  monitor the exact run.
- One queued or running match: resume monitoring that exact run.
- One successful match: do not rerun PostgreSQL cleanup; continue with final
  connection revalidation and record deletion.
- One failed match: surface the cleanup failure. Do not silently replace the
  evidence with another run.
- Multiple matching runs, malformed matching state, contradictory metadata, or
  an unresolvable start result: require recovery.

Local abort stops monitoring and UI work but does not reinterpret or cancel a
durable runner operation.

If cleanup succeeds and `deleteConnection` fails, the record remains. A retry
recognizes the successful cleanup run and retries only final validation and
record deletion.

Cleanup SQL is idempotent, providing defense in depth for concurrent attempts.
If concurrent validated workflows reach record deletion, a not-found response
may be treated as success only after that workflow established successful
cleanup for its approved target. A not-found response during initial target
resolution is never success.

## Errors and Child Close Behavior

The child interface uses fixed, non-secret responses:

| Status | Meaning |
| --- | --- |
| `400` | Invalid request metadata or missing trusted calling manager |
| `404` | Requested connection is absent, inaccessible, unowned, or no eligible owned connections exist |
| `409` | The approved connection changed, or concurrent work for the same target cannot be safely joined |
| `499` | The user cancelled deletion |
| `503` | Installation, connection, platform, or run state requires administrative recovery |
| `500` | Confirmed cleanup failure, record deletion failure, or normalized unexpected failure |

Internal RPC payloads, SQL output, Docker errors, credentials, and raw thrown
values never cross `wire.close()`. The component guards success, cancellation,
abort, and error races so the child wire closes at most once. Component cleanup
still ends listeners independently through the application client lifecycle.

## Testing

Implementation follows test-driven development and adds focused coverage for:

- Exact request parsing, including optional connection ID, blank IDs, extra
  fields, prototype-shaped inputs, and invalid action values.
- App routing among create, delete, and dashboard modes without reroute during
  run events or React Strict Mode effect replay.
- Paginated manager/resource filtering, stable totals, duplicate summaries,
  malformed labels, full-record validation, and absent/unowned equivalence.
- Supplied-target confirmation and user selection when the target is omitted.
- Accessible dialog naming, focus trapping, Escape/Cancel behavior, selected
  consequence text, disabled/busy behavior, and single submission.
- Cancellation producing no run or delete call and exactly-once child close.
- Both revalidation boundaries, including changes to ownership, resource,
  external flag, access, credentials, labels, database, and platform.
- Cleanup plan selection for created database, existing database, constrained
  full access, and superuser full access.
- Queued, running, successful, failed, malformed, duplicated, ambiguous-start,
  and unrelated cleanup-run histories.
- Proof that `deleteConnection` is never called before successful cleanup.
- Retry after successful cleanup followed by failed record deletion.
- Safe reconciliation of concurrent record deletion and initial not-found
  behavior.
- Password and raw-error redaction from rendered text and close responses.

Docker-backed PostgreSQL integration tests prove that:

- A connection-created database and its generated role are removed.
- A pre-existing database survives while its generated role is removed.
- Full-access cleanup preserves databases and removes only the generated role.
- Cleanup remains idempotent and emits no credentials.

## Documentation

Update the project README and PostgreSQL manager integration guide with:

- Both supported request forms.
- The trusted calling-manager ownership rule.
- Selection and mandatory confirmation behavior.
- Database-versus-role deletion semantics.
- The non-secret success result and error table.
- Run-backed retry and recovery behavior.

The public documentation must call the interface action `delete-connection`
and distinguish it from the internal `cleanup-connection` runner action.

## Non-Goals

This feature does not:

- Delete the PostgreSQL installation, service, volume, or primary resource.
- Delete pre-existing databases.
- Allow deletion by labels, database name, username, or caller-supplied manager
  identity.
- Add bulk deletion.
- Add remembered destructive approval.
- Add direct Deploy Commander HTTP calls or direct browser-to-PostgreSQL
  access.
- Add a manager database, operation journal, or browser-persisted recovery
  state.
