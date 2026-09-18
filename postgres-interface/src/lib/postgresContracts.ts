import type { AccessRequest } from './postgresConnectionRequest';

export interface PlatformConnection {
  type: 'Platform';
  data: {
    network: string;
  };
}

export interface PostgresConnectionMetadata {
  host: 'postgres';
  port: 5432;
  database: string;
  username: string;
  password: string;
  platform_connection: PlatformConnection;
  /** The approved access mode used to provision this login. */
  access: AccessRequest;
}

/** A connection to be materialized by the Deploy Commander runner. */
export interface RunnerConnectionCreate {
  /** Runner-only object-hook name; omitted from the persisted connection. */
  name?: string;
  manager: string;
  resource: { id: string };
  metadata: PostgresConnectionMetadata;
  labels?: Record<string, string>;
}

/** A query executed by a runner object hook. */
export interface DatabaseQuery {
  query: string;
  bindings?: Record<string, unknown>;
}

/** Lifecycle queries associated with a runner object. */
export interface ObjectHooks {
  kind: 'container' | 'volume' | 'network' | 'resource' | 'connection';
  name: string;
  create?: { before?: DatabaseQuery; after?: DatabaseQuery };
  remove?: { before?: DatabaseQuery; after?: DatabaseQuery };
}

export interface RunnerService {
  image: string;
  aliases?: string[];
  role?: 'service' | 'runner';
  connections?: PlatformConnection[];
  resources?: Array<{
    resource_type: string;
    name: string;
    metadata: Record<string, unknown>;
  }>;
  environment?: Record<string, string>;
  volumes?: Array<{
    name: string | null;
    mount_path: string;
  }>;
  command?: string[];
}

export interface RunnerMetadata {
  services?: Record<string, RunnerService>;
  connections?: { create?: RunnerConnectionCreate[] };
  object_hooks?: ObjectHooks[];
  remove_services?: string[];
  volumes?: string[];
  remove_volumes?: string[];
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCreateConnectionMetadata(
  value: unknown,
): value is { action: 'create-connection' } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Object.keys(value)[0] === 'action' &&
    value.action === 'create-connection'
  );
}

export function parsePlatformConnection(value: unknown): PlatformConnection {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.type !== 'Platform' ||
    !isRecord(value.data)
  ) {
    throw new Error('Invalid platform connection');
  }

  if (Object.keys(value.data).length !== 1 || typeof value.data.network !== 'string') {
    throw new Error('Invalid platform connection');
  }

  const network = value.data.network.trim();
  if (network.length === 0) {
    throw new Error('Invalid platform connection');
  }

  return { type: 'Platform', data: { network } };
}
