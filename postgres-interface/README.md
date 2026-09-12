# Deploy Commander PostgreSQL manager

This manager installs one persistent PostgreSQL 15 service and provisions isolated logical databases for consuming managers. All Deploy Commander communication goes through `@ezenki/deploy-commander-installer-interface`; the browser never talks directly to the Deploy Commander API or to Docker.

## Interface contract

For the complete consumer-facing contract and an integration example, see [PostgreSQL Manager Interface Guide](../docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md).

The parent interface starts this manager with the exact metadata object:

```json
{ "action": "create-connection" }
```

Any additional or unknown field selects the normal manager dashboard. In connection mode, the caller identity is supplied by Deploy Commander. It is not accepted from editable metadata.

The installed resource has stable identity:

```text
type: postgres
name: postgres
```

Its platform connection is read from the resource and must have the exact shape `{ type: "Platform", data: { network: string } }`. The runner uses the `postgres` service alias and the persistent `postgres-data` volume.

## State and credentials

The latest relevant lifecycle action and status are the installation truth. Administrator credentials live in owner-scoped PostgreSQL resource metadata and are never exposed in the UI, local storage, or errors. Credential-less existing resources cannot be safely adopted; teardown and reinstall are required.

The runner may receive administrator and per-connection credentials through the access-controlled manager-scoped run configuration needed to execute its environment. Runner output is quiet and credentials are not logged.

Each logical connection gets a generated database, role, username, and password. Those per-connection credentials are stored only in the Deploy Commander connection created for the consuming manager (and the manager-scoped runner transport while provisioning). The connection metadata contains the PostgreSQL host, port, database, username, and password; it never contains the primary administrator credentials.

## Operations and recovery

Installation and teardown are resource-based and use exact run IDs. Runner status values are queued `0`, running `1`, done `2`, and failed `3`; `getRun(id)` is the authoritative fallback when an event is missed. Provisioning waits for PostgreSQL readiness, uses identifier/value-safe SQL, and is idempotent. Connection recovery uses versioned run notes/configuration and Deploy Commander connection records.

Connection requests can request approval, automatically install PostgreSQL when needed, then provision an isolated database. Duplicate connections are checked before permission prompting or provisioning. A failed or ambiguous provisioning operation is recovered with a compensating cleanup run. A Deploy Commander connection is created only after provisioning succeeds.

Remembered connection approval is installation-scoped and stored in browser local storage under a key containing the current manager and PostgreSQL resource IDs. Resetting approval removes only that exact key. A storage failure never grants permission implicitly.

## Local development

From this directory:

```sh
npm install
npm run dev
npm test
npm run lint
npm run build
```

The UI is designed for the embedded manager frame and uses Tailwind CSS 4 through the Vite plugin. `npm test` uses Vitest with a jsdom environment.

## Opt-in PostgreSQL integration check

The PostgreSQL integration test is skipped by default. To run it, start a disposable `postgres:15` container and provide its name:

```sh
integration_container=dc-postgres-installer-integration
docker run --name "$integration_container" \
  -e POSTGRES_USER=integration_admin \
  -e POSTGRES_PASSWORD=integration_only_password \
  -e POSTGRES_DB=postgres \
  -d postgres:15
POSTGRES_INTEGRATION_CONTAINER="$integration_container" npm test -- src/lib/postgresIntegration.test.ts
docker rm -f "$integration_container"
```

The test uses `docker exec -i` and passes the scripts through the container command boundary; it does not require a host `psql` binary. It verifies idempotent role/database creation, ownership and scoped privileges, cleanup, and output redaction.
