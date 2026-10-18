# PostgreSQL Manager Interface Guide

This guide defines the PostgreSQL manager's child-interface contract and the steps any consuming
manager needs to connect a service to PostgreSQL. The manager derives state from its PostgreSQL
resource and the connections attached to that resource. Run events report transient progress;
completed runs are not a source of truth.

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

## PostgreSQL endpoint and transport

| Setting               | Current contract                                                            | Where a consumer obtains it                                                                   |
| --------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Host                  | `postgres`                                                                  | Live connection `config.metadata.host`                                                        |
| Port                  | `5432` (TCP)                                                                | Live connection `config.metadata.port`                                                        |
| Database              | Requested database for database access; `postgres` for full access          | Live connection `config.metadata.database`                                                    |
| Username and password | Per-connection Deploy Commander secrets named `USERNAME` and `PASSWORD`     | `config.metadata.secret_keys` declares the names; runner secret references resolve the values |
| TLS                   | Not configured by this installer; use `sslmode=disable` for this deployment | There is no TLS mode, CA, or certificate field in this contract                               |
| Network               | Private Docker resource network                                             | The runner resolves a `Connection` reference containing the resource and connection UUIDs     |

`postgres` is a Docker DNS alias, not a public domain name or an address reachable from outside
the resource network. The install plan gives the PostgreSQL service that alias. It does not publish
port 5432 on the host or advertise a `public_connection`. A consuming service can resolve and reach
`postgres:5432` only after the runner attaches that service to the resource's network. The runner
does not set the application's host, port, database, TLS mode, or credentials; the consuming manager
must set those values in its service configuration.

The installer uses the stock `postgres:15` image without server TLS configuration or certificate
provisioning. Do not assume `sslmode=require` or an external TLS endpoint works. A deployment that
needs TLS or external access requires a separately defined and implemented contract; a resource
name or an invented DNS name does not provide one.

The resource itself is the manager-owned, non-external `postgres` resource. Its non-secret metadata
declares `engine: "postgres"`, `version: "15"`, and secret key names for the administrator. It does
not carry the consuming connection's host, port, database, or login. Those belong to each logical
connection. The resource ID identifies the PostgreSQL instance; the connection ID identifies a
login and its access rights.

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

Other supported access requests are shown below, one request per line:

```jsonl
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

## Connect a consuming service

The child result is an identity handoff, not a PostgreSQL connection string. Use this sequence
for any manager deploying a service that needs PostgreSQL:

1. Obtain the selected PostgreSQL `ResourceItem` from Deploy Commander's authorized resource
   listing, such as `caller.getResources('postgres', false, undefined, 50, 0)` with pagination.
   Select a non-external item whose `type` and `name` are both `postgres`. Use its `id` as the
   resource UUID and its `manager` as the manager to open. A consumer does not use `getResource`
   to read another manager's private resource configuration.
2. Start the PostgreSQL manager child interface with `wire.startInterface`, passing the resource
   UUID in a `create-connection` request. Specify database access and a database name when the
   service needs its own database; the approval dialog may still let the user choose access.
3. Await `child.close`. Require `ok: true` and a `result.connection` whose `id` is non-empty and
   whose `resource` equals the selected resource UUID. Keep both UUIDs. A close with `ok: false`
   is a failed request, not a usable connection.
4. Call `caller.getConnection(connectionId)` from an authorized manager context. The current
   manager must own the connection or its attached resource. Read the **live**
   `config.metadata.host`, `port`, `database`, `access`, and `secret_keys`. A list result or the
   child result does not contain this configuration. Fail if required fields or the declared
   `USERNAME` and `PASSWORD` keys are missing; do not guess from labels.
5. Put the resource and connection UUIDs in a runner `Connection` reference on every consuming
   service. The runner resolves the resource's current platform network and attaches the service.
   Set the application's host, port, database, and TLS setting from this guide and the live
   connection metadata. Set its username and password with connection secret references.

For example, a manager creating access to a database named `orders` opens the child using the
selected resource's manager ID:

```ts
// postgresResource is the selected ResourceItem from getResources.
const child = await wire.startInterface({
  manager: postgresResource.manager,
  metadata: {
    action: 'create-connection',
    resource: postgresResource.id,
    scope: 'database',
    operation: 'create',
    database: 'orders',
  },
});
const response = await child.close;
if (!response.ok) throw new Error(response.error.message);
const result = response.result as { connection?: { id?: string; resource?: string } };
if (!result.connection?.id || result.connection.resource !== postgresResource.id) {
  throw new Error('PostgreSQL manager returned an invalid connection');
}
const connectionId = result.connection.id;
const details = await caller.getConnection(connectionId);
```

The successful child result contains the `ConnectionItem`. A subsequent `getConnection` returns
its configuration. For this request, the relevant fields look like this (UUIDs and the network
name are examples):

```json
{
  "connection": {
    "id": "22222222-2222-2222-2222-222222222222",
    "manager": "consuming-manager-id",
    "resource": "11111111-1111-1111-1111-111111111111",
    "external": false,
    "labels": {
      "postgres.access": "database",
      "postgres.database": "orders",
      "postgres.database-origin": "managed"
    },
    "created_at": "2026-10-18T00:00:00Z",
    "updated_at": "2026-10-18T00:00:00Z"
  },
  "config": {
    "id": "22222222-2222-2222-2222-222222222222",
    "manager": "consuming-manager-id",
    "resource": "11111111-1111-1111-1111-111111111111",
    "metadata": {
      "host": "postgres",
      "port": 5432,
      "database": "orders",
      "access": { "scope": "database", "operation": "create", "database": "orders" },
      "secret_keys": ["USERNAME", "PASSWORD"]
    },
    "platform_connection": {
      "type": "Platform",
      "data": { "network": "runner-generated-resource-network" }
    }
  }
}
```

Deploy Commander reads `config.platform_connection` live from the resource for an authorized
single-connection read. It is not stored in connection metadata. Consumers normally give the
runner a `Connection` reference instead of copying that network name into a plan. This avoids
stale network snapshots and lets the runner resolve the authorized, current descriptor. The
PostgreSQL resource does not advertise a public address in this installer, so
`config.public_connection` is normally absent. The PostgreSQL manager's
`postgres-internal` network group is an internal plan setting, not a network name that a
consumer should copy.

A consuming runner plan using those IDs and metadata values is:

```json
{
  "values_version": 1,
  "services": {
    "app": {
      "image": "example/app:latest",
      "environment": {
        "PGHOST": "postgres",
        "PGPORT": "5432",
        "PGDATABASE": "orders",
        "PGUSER": "[[secret:connection:22222222-2222-2222-2222-222222222222:USERNAME]]",
        "PGPASSWORD": "[[secret:connection:22222222-2222-2222-2222-222222222222:PASSWORD]]",
        "PGSSLMODE": "disable"
      },
      "connections": [
        {
          "type": "Connection",
          "data": {
            "resource": "11111111-1111-1111-1111-111111111111",
            "connection": "22222222-2222-2222-2222-222222222222"
          }
        }
      ]
    }
  }
}
```

The environment keys above are libpq-compatible examples; adapt them to the application's
configuration names while preserving their values and the runner connection reference. Use
`String(metadata.port)` when building string environment values. The runner interpolates secret
references only with `values_version: 1` on a values-capable runner. It does not generate a
database URL, inject these environment keys, or URL-encode interpolated secrets. If an application
requires a URL, have the application or its entrypoint build it at runtime from separate fields
and percent-encode the resolved credentials. Never place a plaintext password in the runner plan.
The database name is not fixed to `orders`: it is whichever database the approved connection
metadata declares. For full access, the declared default database is `postgres`.

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

Linking changes group labels; it does not grant a different manager permission to read connection
configuration or resolve its runner secrets. A consuming manager still needs an authorized
connection: Deploy Commander allows `getConnection` when that manager owns the connection or the
attached resource. Do not treat a successful link result as a credential or network handoff.

A successful link or unlink returns `{ "connection": ConnectionItem }` with fresh labels.
Created connections have origin `created` and cannot be unlinked. Unlinking removes group
membership only; it does not delete the connection, login, database, or PostgreSQL role.

## Credentials and secret metadata

Administrator and connection credentials are Deploy Commander secrets. They are not stored in
resource or connection metadata, runner metadata, labels, logs, or child results. Resource
metadata declares the administrator secret key names, while each connection's metadata declares
its login secret key names alongside its non-secret endpoint and access fields. These are the
respective `config.metadata` objects, shown separately:

```json
{
  "engine": "postgres",
  "version": "15",
  "secret_keys": ["USERNAME", "PASSWORD"]
}
```

```json
{
  "host": "postgres",
  "port": 5432,
  "database": "orders",
  "access": { "scope": "database", "operation": "create", "database": "orders" },
  "secret_keys": ["USERNAME", "PASSWORD"]
}
```

The runner copies the install run's `USERNAME` and `PASSWORD` into the new resource, and copies
provision run secrets into a created connection. Plans refer to values using runner secret
references, for example:

```text
[[secret:run:USERNAME]]
[[secret:resource:postgres-resource-id:PASSWORD]]
[[secret:connection:connection-id:USERNAME]]
```

The resource secrets are administrator credentials for the PostgreSQL manager's provisioning and
cleanup runs. A consuming service uses its **connection** secrets, not the resource administrator
secrets. The manager verifies the presence of both key names with `getSecretKeys`; it never reads
their stored values back. The `secret_keys` array declares available names and does not contain
their values. Missing or unauthorized references fail runner preflight. No migration is required:
this manager has not been released and the prior metadata format is not treated as supported
input.

## Delete a connection

Delete a connection owned by the calling manager, or let the user choose one of that manager's
connections. Each line below is a separate request:

```jsonl
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

A successful single-ID or chooser deletion returns `{ "connection": "deleted-id" }`; an
explicit array returns `{ "connections": ["deleted-id-1", "deleted-id-2"] }`. Those results are
IDs of removed records and cannot be used to connect again.

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
- Select the non-external `postgres` resource and use its `manager` to open the PostgreSQL child
  interface. Include its exact `resource` ID on create, link, and unlink requests.
- Await `child.close`, then read the live connection with `getConnection`; the child result is
  identity only. Create and delete require approval, while link and unlink do not.
- Configure the consuming service from `config.metadata`: Docker alias `postgres`, TCP port
  `5432`, the declared database, connection secrets, and `sslmode=disable` for this deployment.
- Include both resource and connection IDs in each consuming service's runner `Connection`
  reference. Do not guess a Docker network name, public domain, or external port.
- Use `values_version: 1` and connection-scoped `USERNAME` and `PASSWORD` secret references;
  keep credential values out of metadata and runner plans. Do not put caller or manager identity
  inside child request metadata.
- Set both group labels for group-created connections; link imported connections with origin
  `imported`.
- Derive durable state from the current resource and connection records.
