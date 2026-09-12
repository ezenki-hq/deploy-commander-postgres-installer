# PostgreSQL Manager Interface Guide

This guide defines how another Deploy Commander manager requests a logical PostgreSQL database from the PostgreSQL manager implemented in this repository.

The PostgreSQL manager owns one PostgreSQL service and resource. Each consuming manager receives a separate generated database and login through a Deploy Commander connection. Consumers never receive the primary PostgreSQL administrator credentials.

## Prerequisites

Before requesting a connection:

- The PostgreSQL manager must be available in Deploy Commander. A connection request may automatically install PostgreSQL after user approval.
- The consuming manager must know the PostgreSQL manager's Deploy Commander manager ID.
- The consumer must use `@ezenki/deploy-commander-installer-interface` and an active `Wire` created for its own manager interface.

The PostgreSQL manager identifies the consumer with Deploy Commander's trusted calling-manager context. Do not put a manager ID, resource ID, database name, username, or password in the interface metadata.

## Start the connection workflow

Open the PostgreSQL manager as a child interface with this exact metadata object:

```json
{
  "action": "create-connection"
}
```

No other fields are accepted in connection mode. If the object has an additional field, a missing field, or another action, the PostgreSQL manager opens its normal management dashboard instead of the connection workflow.

```ts
import type {
  RPC,
  Wire,
} from "@ezenki/deploy-commander-installer-interface";

export async function requestPostgresConnection(
  wire: Wire,
  postgresManagerId: string,
): Promise<RPC.CreateConnection> {
  const child = await wire.startInterface({
    manager: postgresManagerId,
    metadata: {
      action: "create-connection",
    },
  });

  const response = await child.close;

  if (!response.ok) {
    const status = response.error?.status;
    const error = new Error(
      response.error?.message
      ?? "PostgreSQL connection request failed",
    );
    Object.assign(error, {
      status,
    });
    throw error;
  }

  return response.result as RPC.CreateConnection;
}
```

Keep the child interface open until its `close` promise settles. The PostgreSQL manager may need to show an approval prompt and run provisioning before it returns.

## User approval

Before provisioning a new database, the PostgreSQL manager asks the user to approve access for the trusted calling manager. The user may approve once, remember approval for the current PostgreSQL installation, or cancel. If no installation exists, approval authorizes installation followed by provisioning.

Remembered approval is scoped to both of these values:

- The PostgreSQL manager installation
- The PostgreSQL resource

It is installation-wide, so a remembered approval applies to later connection requests for that same PostgreSQL installation, including requests from other consuming managers. The PostgreSQL manager dashboard lets the administrator reset it.

It is browser-local preference data, not an authorization credential. Deploy Commander remains the authorization boundary. A browser-storage failure does not grant access.

Duplicate detection happens before the approval prompt. If this consuming manager already owns a connection to the current PostgreSQL resource, the existing connection is returned without provisioning another database or asking again.

## Successful result

On success, the child closes with an `InterfaceResponse` equivalent to:

```ts
{
  manager: postgresManagerId,
  ok: true,
  result: {
    connection: {
      id: string,
      manager: consumingManagerId,
      resource: postgresResourceId,
      external: false,
      created_at: string,
      updated_at: string,
    },
    config: {
      id: string,
      manager: consumingManagerId,
      resource: postgresResourceId,
      metadata: {
        host: "postgres",
        port: 5432,
        database: string,
        username: string,
        password: string,
        platform_connection: {
          type: "Platform",
          data: {
            network: string,
          },
        },
      },
    },
  },
}
```

Treat `result` as `RPC.CreateConnection` from the shared interface package rather than maintaining a local copy of the complete Deploy Commander connection type. The schema above highlights the fields this PostgreSQL manager creates and validates.

The connection metadata fields are:

| Field | Type | Meaning |
| --- | --- | --- |
| `host` | `"postgres"` | Docker service alias on the resource's platform network |
| `port` | `5432` | PostgreSQL TCP port |
| `database` | `string` | Generated logical database owned by this connection |
| `username` | `string` | Generated login role scoped to the logical database |
| `password` | `string` | Generated password for that login role |
| `platform_connection` | `PlatformConnection` | Authoritative runner-generated Docker resource connection; pass the complete value to the consuming service's `connections` array |

The returned username and password belong only to the consuming manager's logical database. They are not the primary PostgreSQL administrator credentials.

## Using the connection

Use the returned metadata as sensitive connection configuration:

```ts
const created = await requestPostgresConnection(
  wire,
  postgresManagerId,
);

const metadata = created.config.metadata as {
  host: "postgres";
  port: 5432;
  database: string;
  username: string;
  password: string;
  platform_connection: {
    type: "Platform";
    data: { network: string };
  };
};

const plan = {
  services: {
    app: {
      image: "your-application-image",
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

Pass the application fields separately to the PostgreSQL client or workload configuration, and pass the complete `platform_connection` unchanged to the consuming service's runner plan. The `PlatformConnection` is runner input; its Docker network string is not an application environment variable. Do not reconstruct, prefix, or rename `data.network`, and do not create the network yourself.

The runner attaches the consuming service to the exact existing Docker network named by the resolved platform connection. The hostname `postgres` resolves only for a workload whose runner service includes this connection. Code running outside that network should not assume the alias is resolvable.

The child workflow enriches otherwise-valid legacy records at response time. Re-open the child workflow when obtaining a connection instead of assuming that a separately cached historical `getConnection` response includes `platform_connection`. The complete metadata object contains credentials and must not be logged or copied into resource metadata, interface metadata, URLs, browser persistence, run notes, or error messages.

## Failure contract

On failure, the child closes with `ok: false`. Handle the status as follows:

| Status | Message | Meaning | Consumer action |
| --- | --- | --- | --- |
| `400` | `A calling manager is required` | The interface was not opened through a valid manager relationship. | Fix the parent/child invocation. Retrying unchanged will not help. |
| `409` | `A PostgreSQL operation is already in progress` | Installation, teardown, recovery, or another connection operation owns the manager-wide operation lock. | Wait and retry later. Do not open concurrent retry children. |
| `499` | `Database access was cancelled` | The user denied or cancelled approval. | Stop. Retry only after an explicit new user action. |
| `503` | `PostgreSQL recovery is required` | The installation or a previous operation is not safely ready for provisioning. Credential-less existing resources require teardown and reinstall. | Ask the PostgreSQL manager owner to open its dashboard and complete recovery. |
| `500` | `Unable to create the PostgreSQL connection` | Provisioning or connection persistence failed, or the failure was intentionally normalized. | Report a non-secret error and allow a deliberate retry. |

Messages are deliberately normalized. Consumers must not depend on unlisted internal error details.

## Retry and idempotency behavior

A request is keyed by the trusted calling manager and the current PostgreSQL resource. The PostgreSQL manager allows at most one non-external connection for that pair.

Safe consumer behavior is:

1. Start one child interface.
2. Wait for its close result.
3. On `409`, wait before starting a new child.
4. On `503`, require manager recovery before retrying.
5. On an uncertain parent-side transport failure, reopen the workflow instead of creating a PostgreSQL database directly.

The manager checks for an existing connection before prompting or provisioning and again around connection creation. If a previous request committed successfully but its response was lost, a later request returns the existing Deploy Commander connection. Provisioning recovery and compensating cleanup remain internal to the PostgreSQL manager.

## Ownership and lifecycle

- The PostgreSQL manager owns the PostgreSQL service, resource, volume, administrator credentials in owner-scoped resource metadata, provisioning runs, and recovery state encoded in versioned run notes/configuration and connection records.
- The consuming manager owns the returned Deploy Commander connection and its logical database credentials.
- The consumer must not use the administrator account or issue its own role/database provisioning SQL.
- Tearing down the PostgreSQL installation is a PostgreSQL-manager administrative action and affects all logical connections. It is not exposed through the connection-request interface.
- This interface currently creates or returns a connection. It does not define a child-interface action for deleting an individual logical connection.

## Consumer checklist

- Open the configured PostgreSQL manager ID with exactly `{ action: "create-connection" }`.
- Trust Deploy Commander to supply caller identity; do not send identity in metadata.
- Wait for `child.close` and handle both success and failure.
- Use `RPC.CreateConnection` from the shared package.
- Treat `config.metadata` and especially `password` as secrets.
- Run the consuming workload on the connection's platform network so `postgres:5432` is reachable.
- Serialize retries and respect `409`, cancellation, and recovery responses.
- Reuse a returned existing connection instead of attempting independent PostgreSQL provisioning.
