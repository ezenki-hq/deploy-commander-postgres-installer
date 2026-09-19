# PostgreSQL Manager Interface Guide

This guide describes the child-interface contract for requesting a connection to the
PostgreSQL service managed by this repository. A consuming manager opens the PostgreSQL
manager as a child interface and supplies a request in metadata. The PostgreSQL manager
obtains the caller identity from Deploy Commander; callers must not put manager IDs,
resource IDs, credentials, or connection details in metadata.

The request is a proposal. Every request requires an explicit user decision. A manager's
proposal is displayed read-only when it contains access details, and the user can approve
or reject it. When the manager leaves access details out, the user configures the access
scope in the approval dialog before approving.

## Prerequisites

Before requesting a connection:

- The PostgreSQL manager must be available in Deploy Commander, or the user must allow
  the request to install it.
- The consuming manager must know the PostgreSQL manager's Deploy Commander manager ID.
- The consumer must use `@ezenki/deploy-commander-installer-interface` and an active
  `Wire` created for its own manager interface.

The PostgreSQL manager uses the trusted calling-manager context supplied by Deploy
Commander. Do not send a calling-manager ID, PostgreSQL resource ID, username, password,
or platform connection in request metadata.

## Request metadata

Open the PostgreSQL manager as a child interface with `action: "create-connection"`.
Metadata is a flat object. `labels` is optional and may contain arbitrary string keys and
values, except for the reserved keys described below. Access fields are optional as a
group: either provide a complete access request or provide no access fields and let the
user configure it.

These are the supported request variants:

Labels only; the user chooses database or full access in the approval dialog:

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

Constrained full access (not a PostgreSQL superuser):

```json
{ "action": "create-connection", "scope": "full", "superuser": false }
```

Dedicated PostgreSQL superuser access:

```json
{ "action": "create-connection", "scope": "full", "superuser": true }
```

The parser rejects unknown fields and incomplete access objects. Database names must be
non-empty, contain no NUL, not be `template0` or `template1`, and fit within 63 UTF-8
bytes. Labels must have string values. The PostgreSQL manager adds these labels to the
created connection:

| Label               | Value                                              |
| ------------------- | -------------------------------------------------- |
| `postgres.access`   | `database` or `full`                               |
| `postgres.database` | The database name, for database-scoped access only |

Callers may add labels, but may not provide either reserved key (including with surrounding
whitespace). Caller labels are forwarded to the connection unchanged. A caller that
attempts to override a reserved label receives a normalized `400` error.

## Starting the workflow

Use the shared wire API to start the child interface and wait for its close response:

```ts
import type { RPC, Wire } from '@ezenki/deploy-commander-installer-interface';

export async function requestPostgresConnection(
  wire: Wire,
  postgresManagerId: string,
  metadata: Record<string, unknown>,
): Promise<RPC.CreateConnection> {
  const child = await wire.startInterface({
    manager: postgresManagerId,
    metadata,
  });

  const response = await child.close;
  if (!response.ok) {
    const error = new Error(response.error?.message ?? 'PostgreSQL connection request failed');
    Object.assign(error, { status: response.error?.status });
    throw error;
  }
  return response.result as RPC.CreateConnection;
}
```

Keep the child interface open until `child.close` settles. The manager may need to show
the approval dialog, install PostgreSQL, query its catalog, provision access, and persist a
connection before it closes.

## Approval and user configuration

Approval is mandatory for every request, including a request that matches a connection
created previously. The manager does not remember approval in browser storage, and there
is no remember-approval checkbox. Deploy Commander remains the authorization boundary.

For a request that includes `scope`, `operation`, `database`, or `superuser`, the approval
dialog shows the proposal read-only. The user can approve that exact access or reject it;
the user cannot silently change the manager's proposed access. For labels-only metadata,
the dialog asks the user to choose:

- database access, then create a new database or use an existing database;
- a database name, including an optional generated name; or
- full access, with either constrained access or a dedicated superuser.

Generated names use the form `db_` followed by 32 lower-case hexadecimal characters from
secure random bytes. A generated name is only a candidate; provisioning checks for a
collision and fails safely if the name is already in use. The manager never takes ownership
of an existing database merely because a create request used a colliding name.

Constrained full access is a dedicated login with `CREATEDB` and broad permissions
appropriate to the PostgreSQL installation, but without `SUPERUSER`, `CREATEROLE`,
replication, or bypass-row-level-security privileges. Superuser access is a separate
explicit choice and should be approved only for a fully trusted caller. Database access
creates a dedicated login; existing-database access grants broad database-local access
without changing the existing database owner.

Rejecting the dialog closes the child with status `499`. The consuming manager should not
retry rejection without a new user action.

## Multiple connections and identity

The PostgreSQL manager permits multiple connections for the same calling manager and
resource. A request identity includes:

- the trusted calling-manager ID;
- the PostgreSQL resource ID;
- database versus full scope;
- the database name for database scope; and
- the `superuser` choice for full scope.

The database `operation` (`create` versus `existing`) and caller labels are compatibility
checks on that identity, not additional identity dimensions. Unrelated connections remain
available. If exactly one connection matches the identity and compatibility checks, that
connection is returned. If multiple exact matches exist, or a matching identity has a
different operation or labels, the request fails with a conflict instead of selecting
arbitrarily.

The calling manager and resource are derived from Deploy Commander, not request metadata.
Do not use a connection name as a user-facing identity: the runner-only plan name
`postgres-connection` selects the connection object hook and is not persisted as the
caller-provided logical name.

## Successful result

On success, `child.close` contains an `InterfaceResponse` equivalent to:

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
        access: {
          scope: 'database',
          operation: 'create',
          database: 'orders',
        },
        platform_connection: {
          type: 'Platform',
          data: { network: string },
        },
      },
    },
  },
}
```

The access discriminator in `config.metadata.access` exactly records the approved mode:

```ts
// Database request
{ scope: 'database', operation: 'create' | 'existing', database: string }

// Full request
{ scope: 'full', superuser: boolean }
```

For full access, `metadata.database` is `postgres`; the `access` field is still the
authoritative indication of constrained versus superuser access. `platform_connection`
is the authoritative runner-generated Docker network connection. Pass its complete value
to a consuming service's `connections` array; do not reconstruct it or create the network.

Treat `result.config.metadata` as sensitive connection configuration. The generated
username and password belong to this connection's login and are never the PostgreSQL
administrator credentials.

## Using the connection

Pass the application fields to the PostgreSQL client and the complete platform connection
to the consuming service's runner plan:

```ts
const metadata = created.config.metadata as {
  host: 'postgres';
  port: 5432;
  database: string;
  username: string;
  password: string;
  access: { scope: 'database' | 'full'; [key: string]: unknown };
  platform_connection: {
    type: 'Platform';
    data: { network: string };
  };
};

const plan = {
  services: {
    app: {
      image: 'your-application-image',
      connections: [metadata.platform_connection],
      environment: {
        PGHOST: metadata.host,
        PGPORT: String(metadata.port),
        PGDATABASE: metadata.database,
        PGUSER: metadata.username,
        PGPASSWORD: metadata.password,
      },
    },
  },
};
```

The hostname `postgres` resolves for a workload whose runner service includes this
platform connection. Code outside that network must not assume the alias is resolvable.

## Delete a connection

The consuming manager may request deletion of one of its own connections:

```json
{ "action": "delete-connection", "connection": "connection-1" }
```

Or omit `connection` to have the user select from connections owned by the trusted caller:

```json
{ "action": "delete-connection" }
```

Caller identity is supplied by Deploy Commander and cannot be forged in metadata. A
specified connection that is missing or owned by another manager returns the same `404`.
Every deletion requires explicit confirmation. On success, the child closes with only the
deleted ID:

```json
{
  "manager": "postgres-manager-id",
  "ok": true,
  "result": { "connection": "connection-1" }
}
```

Cleanup always finishes before the connection record is deleted:

| Connection access                 | PostgreSQL effect                                       |
| --------------------------------- | ------------------------------------------------------- |
| Database, `operation: "create"`   | Delete the generated database and user.                 |
| Database, `operation: "existing"` | Preserve the database; delete only the generated user.  |
| Full access, constrained          | Preserve all databases; delete only the generated user. |
| Full access, superuser            | Preserve all databases; delete only the generated user. |

If a response is lost, reopen the child workflow. Durable cleanup history is reconciled by
the exact caller, resource, user, access mode, credentials, and platform before a retry is
accepted; successful cleanup is reused and record deletion is retried without starting a
second cleanup. A changed target or ambiguous history requires recovery.

## Resource and connection authority

The existing PostgreSQL resource determines installation state. Connections on that resource
determine logical access; active runs are transient and completed runs are not state. The
manager does not use a database catalog or `databaseQuery`.

Database-scoped connections use `postgres.access=database`, `postgres.database=<name>`, and
`postgres.database-origin=managed|existing`. Full-access connections use
`postgres.access=full` and do not carry database labels. Only the final connection to a
manager-created (`managed`) database may remove that database. Other deletions remove only the
connection role.

## Failure contract

Failures close the child with `ok: false`. Statuses are normalized; consumers should not
depend on internal runner messages or SQL details.

| Status | Meaning                                                                          | Consumer action                                                                                          |
| ------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid request metadata, missing caller context, or invalid approved access     | Fix the request or parent/child invocation; do not retry unchanged.                                      |
| `404`  | The requested existing database was not found                                    | Choose a valid database and ask for a new approval.                                                      |
| `409`  | An operation lock or exact-identity/label conflict prevents the request          | Serialize requests, inspect existing connections, and retry deliberately after the conflict is resolved. |
| `499`  | The user rejected or cancelled approval                                          | Stop; retry only after a new user action.                                                                |
| `500`  | Provisioning, cleanup, persistence, or compensation failed                       | Report a non-secret error and ask the user to retry deliberately.                                        |
| `503`  | PostgreSQL installation, malformed deletion history, or run recovery is required | Ask the PostgreSQL manager owner to open its dashboard and complete recovery before retrying.            |

## Recovery and retry behavior

Provisioning and cleanup runs carry versioned, credential-free operation notes. A request
whose transport response is lost can be reopened: the manager reconciles the exact run,
checks the connection record, and returns it if the operation already committed. If a run
failed after PostgreSQL objects were created, the manager starts a compensating cleanup
run. Cleanup drops a database only when this request created it; existing databases and
full-access requests never cause a database to be dropped.

Recommended consumer behavior:

1. Start one child interface and wait for `child.close`.
2. On `409`, wait for the manager-wide operation to finish and serialize the next attempt.
3. On `503`, require manager recovery before retrying.
4. On an uncertain transport failure, reopen the child workflow; do not create PostgreSQL
   roles or databases directly.

The manager may return an already persisted exact connection. It never returns a different
connection merely because it shares the same calling manager or resource.

## Secret handling and ownership

- The PostgreSQL manager owns the PostgreSQL service, resource, administrator credentials,
  lifecycle runs, database catalog, and recovery state.
- The consuming manager owns the returned Deploy Commander connection and its generated
  login credentials.
- Do not log, persist in browser storage, place in URLs, copy into interface metadata, put
  in run notes, or include in error messages any returned password or complete connection
  metadata.
- Do not use the administrator account or issue provisioning SQL yourself.
- Tearing down the PostgreSQL installation is an administrative manager action and affects
  all logical connections. Individual deletion is available only through the owned
  `delete-connection` child action described above.

The implementation uses the standard `ezenki/deploy-commander-runner:latest` runner and
the regular `postgres:15` image. Consumers should treat those implementation details as
opaque and rely on the interface and returned connection contract.

## Consumer checklist

- Send one of the supported flat request objects above.
- Keep caller identity and connection details out of metadata.
- Wait for `child.close` and handle both success and normalized failure statuses.
- Expect explicit approval for every request; do not assume prior approval is remembered.
- Use `RPC.CreateConnection` from the shared package.
- Treat `config.metadata`, especially `password`, as a secret.
- Pass the complete `platform_connection` unchanged to the consuming runner plan.
- Serialize retries and respect cancellation, conflicts, and recovery responses.
- Reopen the workflow after an uncertain response instead of provisioning PostgreSQL
  independently.
