# PostgreSQL Manager Interface Guide

This guide defines the PostgreSQL manager's child-interface contract. The manager derives
state from its PostgreSQL resource and the connections attached to that resource. Run events
report transient progress; completed runs are not a source of truth.

## Prerequisites

Install PostgreSQL from the manager dashboard before requesting a connection. Every request
that creates, links, or unlinks a connection names the PostgreSQL `resource` it targets. The
manager verifies that the resource is the exact non-external `postgres` resource owned by the
current manager. Caller and manager identities come from Deploy Commander, not request
metadata.

The runner must support the Deploy Commander values contract, including `values_version: 1`,
`[[secret:run:KEY]]`, `[[secret:resource:UUID:KEY]]`, and
`[[secret:connection:UUID:KEY]]` references and secret-copy lists. Deploy with a runner image
that implements these values before using this manager.

## Create a connection

Each create request requires approval, including reuse of an exact existing connection. A
rejected or cancelled approval closes the child with status `499`.

```json
{
  "action": "create-connection",
  "resource": "postgres-resource-id",
  "scope": "database",
  "operation": "create",
  "database": "orders",
  "labels": { "environment": "production" }
}
```

Other supported access requests are:

```json
{ "action": "create-connection", "resource": "postgres-resource-id" }
{ "action": "create-connection", "resource": "postgres-resource-id", "scope": "database", "operation": "existing", "database": "warehouse" }
{ "action": "create-connection", "resource": "postgres-resource-id", "scope": "full" }
{ "action": "create-connection", "resource": "postgres-resource-id", "scope": "full", "superuser": true }
```

When `scope` is `full`, omitting `superuser` means constrained access. Database access requires
`operation` (`create` or `existing`) and a database name. Names must be non-empty, contain no
NUL, not be `template0` or `template1`, and fit within 63 UTF-8 bytes. Callers may pass unrelated
string labels but may not set the reserved `postgres.*` labels.

For group-created connections, include both labels below. They are added to the connection
alongside any caller labels:

```json
{
  "custom_deployer_group_id": "group-id",
  "custom_deployer_connection_origin": "created"
}
```

The manager reuses a compatible connection only when its resource, caller, access, caller
labels, and exact group membership match. A connection from another group is never reused.

### Create result

A successful child response contains the authoritative connection item only. It does not return
connection config or secret values:

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
        custom_deployer_group_id: 'group-id',
        custom_deployer_connection_origin: 'created',
      },
      created_at: string,
      updated_at: string,
    },
  },
}
```

## Link and unlink a connection

Link and unlink requests are scoped to an exact resource and connection. They do not show an
extra approval dialog. Deploy Commander must open the manager with the trusted manager identity;
never put a manager ID in metadata.

Link an existing compatible connection into a group:

```json
{
  "action": "link-connection",
  "resource": "postgres-resource-id",
  "connection": "connection-id",
  "labels": {
    "custom_deployer_group_id": "group-id",
    "custom_deployer_connection_origin": "imported"
  }
}
```

Unlink an imported group connection:

```json
{
  "action": "unlink-connection",
  "resource": "postgres-resource-id",
  "connection": "connection-id",
  "group": "group-id"
}
```

The manager may link a connection owned by a different manager when that connection is attached
to the exact requested PostgreSQL resource. It preserves unrelated labels and the PostgreSQL
access labels. Link marks the connection `imported` before adding group membership. Unlink
removes group membership before removing the `imported` origin. These orders allow a retry to
complete safely if one label update fails.

A successful link or unlink returns `{ "connection": ConnectionItem }` with fresh labels.
Created connections have origin `created` and cannot be unlinked. Unlinking removes group
membership only; it does not delete the connection, login, database, or PostgreSQL role.

## Credentials and secret metadata

Administrator and connection credentials are Deploy Commander secrets. They are not stored in
resource or connection metadata, runner metadata, labels, logs, or child results. Resource and
connection metadata contain only the public declaration:

```json
{ "secret_keys": ["USERNAME", "PASSWORD"] }
```

The runner copies the install run's `USERNAME` and `PASSWORD` into the new resource, and copies
provision run secrets into a created connection. Plans refer to values using runner secret
references, for example:

```text
[[secret:run:USERNAME]]
[[secret:resource:postgres-resource-id:PASSWORD]]
[[secret:connection:connection-id:USERNAME]]
```

The manager verifies the presence of both key names with `getSecretKeys`; it never reads their
stored values back. No migration is required: this manager has not been released and the prior
metadata format is not treated as supported input.

## Delete a connection

Delete a connection owned by the calling manager, or let the user choose one of that manager's
connections:

```json
{ "action": "delete-connection", "connection": "connection-id" }
{ "action": "delete-connection" }
```

An explicit array can request several connections attached to the manager's PostgreSQL
resource:

```json
{ "action": "delete-connection", "connections": ["connection-1", "connection-2"] }
```

Every deletion requires approval. The chooser lists only connections owned by the calling
manager. An explicit array is checked against the exact PostgreSQL resource regardless of each
connection's owner. The manager rejects the entire array before approval or cleanup if any ID is
missing from that resource or has origin `imported`; unlink imported connections instead. It
refreshes targets, secret-key declarations, labels, and peer state after approval and returns
`409` if any changed. An array runs one ordered cleanup plan and removes records only after all
cleanup steps succeed.

Cleanup effects are:

| Connection                        | PostgreSQL effect                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| Database, `operation: "create"`   | Delete its login and database only when it is the final connection to a `managed` database. |
| Database, `operation: "existing"` | Delete its login; preserve the database.                                                    |
| Full, constrained                 | Delete its login; preserve all databases.                                                   |
| Full, superuser                   | Delete its login; preserve all databases.                                                   |

The `postgres.database-origin=managed` label is the authority for database ownership. A name
match alone never authorizes database removal.

## Failure contract

Failures close the child with `ok: false` and a normalized status:

| Status | Meaning                                                                       |
| ------ | ----------------------------------------------------------------------------- |
| `400`  | Invalid request, resource ownership mismatch, or missing required secret key. |
| `404`  | PostgreSQL is not installed, or a selected connection/database is absent.     |
| `409`  | Resource, identity, group label, or approval-time conflict.                   |
| `499`  | The user rejected or cancelled a create or delete approval.                   |
| `500`  | Provisioning, label update, cleanup, persistence, or run tracking failed.     |

Messages do not contain passwords, SQL output, or runner logs. Retry after the underlying
resource or connection state changes; link/unlink can also be retried to finish a partial label
update.

## Consumer checklist

- Install PostgreSQL from the dashboard and use a values-capable runner image.
- Include the exact `resource` on create, link, and unlink requests.
- Keep credentials and manager identities out of metadata.
- Set both group labels for group-created connections; link imported connections with origin
  `imported`.
- Await `child.close`; create and delete require approval, while link and unlink do not.
- Treat `USERNAME` and `PASSWORD` as secrets and use the connection item returned by create,
  link, or unlink as the public result.
- Derive durable state from the current resource and connection records.
