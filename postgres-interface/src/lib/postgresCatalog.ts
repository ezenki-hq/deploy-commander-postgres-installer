import type { RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import type { AccessRequest } from './postgresConnectionRequest';
import type { DatabaseQuery, ObjectHooks } from './postgresContracts';

/** The catalog query is deliberately fixed so runner input cannot alter its schema. */
export const CATALOG_UPSERT_QUERY = String.raw`BEGIN TRANSACTION;
DEFINE TABLE IF NOT EXISTS postgres_database SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS resource_id ON TABLE postgres_database TYPE string;
DEFINE FIELD IF NOT EXISTS name ON TABLE postgres_database TYPE string;
DEFINE FIELD IF NOT EXISTS origin ON TABLE postgres_database TYPE string;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE postgres_database TYPE datetime;
DEFINE INDEX IF NOT EXISTS postgres_database_resource_name ON TABLE postgres_database COLUMNS resource_id, name UNIQUE;
UPSERT type::thing('postgres_database', $record_id)
SET resource_id = $resource_id,
    name = $name,
    origin = IF origin = 'managed' THEN 'managed' ELSE $origin END,
    updated_at = time::now();
COMMIT TRANSACTION;`;

/** Delete is restricted to the deterministic record for a managed database. */
export const CATALOG_DELETE_QUERY = String.raw`DELETE type::thing('postgres_database', $record_id)
WHERE origin = 'managed';`;

export const CATALOG_LIST_QUERY =
  'SELECT name FROM postgres_database WHERE resource_id = $resource_id ORDER BY name';

type CatalogOrigin = 'managed' | 'pre-existing';

function encodeBase64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * Return the stable Surreal record key for a resource/database pair.
 * The NUL separator prevents concatenation collisions (for example `ab` + `c`).
 */
export function catalogRecordId(resourceId: string, database: string): string {
  return encodeBase64Url(new TextEncoder().encode(`${resourceId}\0${database}`));
}

function databaseName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    value.toLowerCase() !== 'template0' &&
    value.toLowerCase() !== 'template1' &&
    new TextEncoder().encode(value).length <= 63
  );
}

function query(
  sql: string,
  resourceId: string,
  database: string,
  origin: CatalogOrigin,
): DatabaseQuery {
  return {
    query: sql,
    bindings: {
      record_id: catalogRecordId(resourceId, database),
      resource_id: resourceId,
      name: database,
      origin,
    },
  };
}

/**
 * Build the connection hook that records a database before its connection is
 * persisted. Full-access requests do not identify one database and therefore
 * have no catalog hook.
 */
export function buildCatalogHook(
  access: AccessRequest,
  resourceId: string,
): ObjectHooks | undefined {
  if (access.scope !== 'database') return undefined;
  return {
    kind: 'connection',
    name: 'postgres-connection',
    create: {
      before: query(
        CATALOG_UPSERT_QUERY,
        resourceId,
        access.database,
        access.operation === 'create' ? 'managed' : 'pre-existing',
      ),
    },
  };
}

/** Build the cleanup hook for a database created by this request. */
export function buildCatalogDeleteHook(
  access: AccessRequest,
  resourceId: string,
): ObjectHooks | undefined {
  if (access.scope !== 'database' || access.operation !== 'create') return undefined;
  return {
    kind: 'container',
    name: 'postgres-admin',
    remove: {
      after: {
        query: CATALOG_DELETE_QUERY,
        bindings: {
          record_id: catalogRecordId(resourceId, access.database),
        },
      },
    },
  };
}

function invalidCatalog(): Error {
  return new Error('Invalid PostgreSQL database catalog response');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the manager-local database inventory. Every statement must succeed;
 * accepting a partial Surreal response would make the approval UI unsafe.
 */
export async function listCatalogDatabases(
  caller: Pick<RPCCaller, 'databaseQuery'>,
  resourceId: string,
): Promise<string[]> {
  let response: unknown;
  try {
    response = await caller.databaseQuery(CATALOG_LIST_QUERY, { resource_id: resourceId });
  } catch {
    throw invalidCatalog();
  }
  if (!isRecord(response) || !Array.isArray(response.results) || response.results.length === 0) {
    throw invalidCatalog();
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const statement of response.results) {
    if (!isRecord(statement) || statement.status !== 'OK' || !Array.isArray(statement.result)) {
      throw invalidCatalog();
    }
    for (const row of statement.result) {
      if (!isRecord(row) || !databaseName(row.name)) throw invalidCatalog();
      if (
        Object.prototype.hasOwnProperty.call(row, 'resource_id') &&
        row.resource_id !== resourceId
      ) {
        throw invalidCatalog();
      }
      if (seen.has(row.name)) throw invalidCatalog();
      seen.add(row.name);
      names.push(row.name);
    }
  }
  return names;
}
