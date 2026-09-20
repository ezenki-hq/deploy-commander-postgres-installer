# PostgreSQL Manager Interface Guide

This is the public child-interface contract for the PostgreSQL manager. The manager derives
durable state only from its Deploy Commander PostgreSQL resource and the connections attached
to that resource. Run events report transient progress; they are not durable state.

## Prerequisites

An existing PostgreSQL resource is required before a connection request can succeed. The
manager never installs PostgreSQL as a side effect of a connection request. A user installs it
from the manager dashboard; clicking Install is the approval for that installation. The
consuming manager needs only the PostgreSQL manager ID and the standard installer interface
wire. Caller and resource IDs are supplied by Deploy Commander and must not be placed in
request metadata.

## Create a connection

Open the PostgreSQL manager as a child interface with a flat metadata object. Every request,
including an exact reuse of an existing connection, displays an approval dialog. Rejection
closes the child with status `499`; there is no remembered approval.

Labels-only; the user chooses access in the dialog:

```json
{ "action": "create-connection", "labels": { "team": "payments" } }
```

Create a new named database:

```json
{
  "action": "create-connection",
  "scope": "database",
  "operation": "create",
  "database": "orders",
  "labels": { "environment": "production" }
}
```

Use an existing database:

```json
{
  "action": "create-connection",
  "scope": "database",
  "operation": "existing",
  "database": "warehouse"
}
```

Constrained full access:

```json
{ "action": "create-connection", "scope": "full", "superuser": false }
```

Dedicated PostgreSQL superuser access:

```json
{ "action": "create-connection", "scope": "full", "superuser": true }
```

The parser rejects unknown fields, incomplete access objects, invalid database names, and
non-string label values. Database names must be non-empty, contain no NUL, not be `template0`
or `template1`, and fit within 63 UTF-8 bytes.

The three labels reserved for the manager are:

| Label                      | Meaning                                            |
| -------------------------- | -------------------------------------------------- |
| `postgres.access`          | `database` or `full`                               |
| `postgres.database`        | Database name for database-scoped access           |
| `postgres.database-origin` | `managed` or `existing` for database-scoped access |

Callers may supply other string labels, but may not supply or override any reserved label.

Start and await the child in the normal way:

```ts
import type { RPC, Wire } from '@ezenki/deploy-commander-installer-interface';

export async function requestPostgresConnection(
  wire: Wire,
  postgresManagerId: string,
  metadata: Record<string, unknown>,
): Promise<RPC.CreateConnection> {
  const child = await wire.startInterface({ manager: postgresManagerId, metadata });
  const response = await child.close;
  if (!response.ok) {
    const error = new Error(response.error?.message ?? 'PostgreSQL connection request failed');
    Object.assign(error, { status: response.error?.status });
    throw error;
  }
  return response.result as RPC.CreateConnection;
}
```

After approval, the manager refreshes the resource and connections. Exactly one compatible
connection may be reused. An ambiguous or incompatible identity returns `409`; no arbitrary
connection is selected. A new connection is provisioned by an idempotent runner plan and the
manager returns only after the connection record is visible.

## Successful create result

`child.close` contains an `InterfaceResponse` equivalent to:

```ts
{
  manager: postgresManagerId,
  ok: true,
  result: {
    connection: {
      id: string,
      manager: callingManagerId,
      resource: postgresResourceId,
      external: false,
      labels: {
        team: 'payments',
        'postgres.access': 'database',
        'postgres.database': 'orders',
        'postgres.database-origin': 'managed',
      },
      created_at: string,
      updated_at: string,
    },
    config: {
      id: string,
      manager: callingManagerId,
      resource: postgresResourceId,
      metadata: {
        host: 'postgres',
        port: 5432,
        database: 'orders',
        username: string,
        password: string,
        access: { scope: 'database', operation: 'create', database: 'orders' },
        platform_connection: { type: 'Platform', data: { network: string } },
      },
    },
  },
}
```

For full access, `metadata.database` is `postgres`; `metadata.access` remains the authority
for constrained versus superuser access. Pass the complete `platform_connection` unchanged in
the consuming service's `connections` array. Treat the returned metadata, especially the
password, as a secret.

## Delete a connection

Delete one of the calling manager's connections:

```json
{ "action": "delete-connection", "connection": "connection-1" }
```

Or let the user select from that manager's connections:

```json
{ "action": "delete-connection" }
```

Every deletion requires explicit confirmation. The manager refreshes the selected connection
and its peers after approval; a changed target or changed cleanup consequence returns `409`
before a run starts. On success the child closes with only the deleted ID:

```json
{
  "manager": "postgres-manager-id",
  "ok": true,
  "result": { "connection": "connection-1" }
}
```

Cleanup finishes before the runner removes the Deploy Commander connection record:

| Connection                        | PostgreSQL effect                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| Database, `operation: "create"`   | Delete its login and database only when it is the final connection to a `managed` database. |
| Database, `operation: "existing"` | Delete its login; preserve the database.                                                    |
| Full, constrained                 | Delete its login; preserve all databases.                                                   |
| Full, superuser                   | Delete its login; preserve all databases.                                                   |

The `postgres.database-origin=managed` label is the authority for database ownership. A
database is never removed because a name happens to match; only the final labeled connection
to a manager-created database can remove it. All other deletions remove only the generated
login and connection.

## Resource and connection authority

Installation state is the exact non-external resource named `postgres` and typed `postgres`.
Multiple such resources are a `409` conflict. Logical access is the set of connections on that
resource, including their reserved labels and returned metadata. Completed runs are not state.

The manager uses run-start and run-update events, followed by an exact run read, to show
starting, queued, running, completed, and failed progress. PostgreSQL operations are safe to
retry using the current resource and connection projections; no historical run is treated as a
source of truth.

## Failure contract

Failures close the child with `ok: false` and a normalized status:

| Status | Meaning                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------ |
| `400`  | Invalid request metadata, caller context, or approved access.                                          |
| `404`  | PostgreSQL is not installed, the selected connection is absent, or an existing database was not found. |
| `409`  | Resource conflict, identity/label conflict, malformed labels, or an approval-time race.                |
| `499`  | The user rejected or cancelled approval.                                                               |
| `500`  | Provisioning, cleanup, persistence, or run tracking failed.                                            |

Messages never contain passwords, SQL output, or runner logs. Consumers should show the
normalized message and retry only after the underlying resource or connection state changes.

## Consumer checklist

- Require the manager dashboard to install PostgreSQL before requesting a connection.
- Send one of the supported flat request objects and keep identities and credentials out of metadata.
- Expect an approval decision for every create and delete request, including exact reuse.
- Await `child.close`, handle statuses `400`, `404`, `409`, `499`, and `500`, and treat `499` as a user decision.
- Use the returned `RPC.CreateConnection` metadata as sensitive configuration.
- Pass `platform_connection` unchanged to the consuming runner plan.
- Derive all durable decisions from the current resource and connection records.
