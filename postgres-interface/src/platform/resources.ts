import type { RPC, RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import { PostgresRequestError } from '../domain/errors';
import { requireCredentialKeys } from './secrets';

const PAGE_SIZE = 50;

export type InstallationProjection =
  | { kind: 'not-installed' }
  | { kind: 'installed'; resource: RPC.ResourceItem }
  | { kind: 'conflict'; resources: RPC.ResourceItem[] };

export type PostgresInstallation = {
  resource: RPC.ResourceItem;
};

function isResource(value: unknown): value is RPC.ResourceItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const resource = value as Partial<RPC.ResourceItem>;
  return (
    typeof resource.id === 'string' &&
    resource.id.trim() !== '' &&
    typeof resource.manager === 'string' &&
    resource.manager.trim() !== '' &&
    typeof resource.type === 'string' &&
    resource.type.trim() !== '' &&
    typeof resource.name === 'string' &&
    resource.name.trim() !== '' &&
    typeof resource.external === 'boolean' &&
    typeof resource.created_at === 'string' &&
    resource.created_at.trim() !== '' &&
    typeof resource.updated_at === 'string' &&
    resource.updated_at.trim() !== ''
  );
}

function invalidResource(message = 'Unable to load PostgreSQL resources'): PostgresRequestError {
  return new PostgresRequestError(500, message);
}

function validPage(value: unknown, offset: number): value is RPC.GetResources {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const page = value as Partial<RPC.GetResources>;
  return (
    Array.isArray(page.items) &&
    page.items.every(isResource) &&
    page.limit === PAGE_SIZE &&
    page.offset === offset &&
    typeof page.total === 'number' &&
    Number.isSafeInteger(page.total) &&
    page.total >= 0 &&
    page.items.length <= PAGE_SIZE &&
    page.items.length <= page.total &&
    page.offset >= 0 &&
    page.offset <= page.total &&
    (page.items.length > 0 || page.total === 0 || page.offset >= page.total)
  );
}

export async function listPostgresResources(caller: RPCCaller): Promise<RPC.ResourceItem[]> {
  const resources: RPC.ResourceItem[] = [];
  let offset = 0;
  while (true) {
    let response: unknown;
    try {
      response = await caller.getMyResources('postgres', false, PAGE_SIZE, offset);
    } catch {
      throw invalidResource();
    }
    if (!validPage(response, offset)) throw invalidResource();
    resources.push(
      ...response.items.filter(
        (item) => item.type === 'postgres' && item.name === 'postgres' && !item.external,
      ),
    );
    if (response.items.length === 0 || offset + response.items.length >= response.total)
      return resources;
    offset += response.items.length;
  }
}

export async function loadInstallationProjection(
  caller: RPCCaller,
): Promise<InstallationProjection> {
  const resources = await listPostgresResources(caller);
  if (resources.length === 0) return { kind: 'not-installed' };
  if (resources.length > 1) return { kind: 'conflict', resources };
  return { kind: 'installed', resource: resources[0] };
}

export async function readInstallation(
  caller: RPCCaller,
  resource: RPC.ResourceItem,
): Promise<PostgresInstallation> {
  let details: RPC.GetResource;
  try {
    details = await caller.getResource(resource.id);
  } catch {
    throw new PostgresRequestError(400, 'PostgreSQL resource configuration is invalid');
  }
  const config = details?.config;
  const metadata = config?.metadata;
  if (
    !isResource(details?.resource) ||
    details.resource.id !== resource.id ||
    details.resource.manager !== resource.manager ||
    details.resource.type !== 'postgres' ||
    details.resource.name !== 'postgres' ||
    details.resource.external ||
    !config ||
    config.id !== resource.id ||
    config.manager !== resource.manager ||
    typeof config.agent !== 'string' ||
    config.agent.trim() === '' ||
    config.resource_type !== 'postgres' ||
    config.name !== 'postgres' ||
    !metadata ||
    metadata.engine !== 'postgres' ||
    metadata.version !== '15' ||
    !Array.isArray(metadata.secret_keys) ||
    metadata.secret_keys.length !== 2 ||
    !metadata.secret_keys.includes('USERNAME') ||
    !metadata.secret_keys.includes('PASSWORD') ||
    Object.hasOwn(metadata, 'username') ||
    Object.hasOwn(metadata, 'password') ||
    Object.hasOwn(metadata, 'administrator')
  ) {
    throw new PostgresRequestError(400, 'PostgreSQL resource configuration is invalid');
  }
  await requireCredentialKeys(caller, 'resource', resource.id);
  return { resource };
}

export async function resolveOwnedPostgresResource(
  caller: RPCCaller,
  managerId: string,
  resourceId: string,
): Promise<RPC.ResourceItem> {
  let details: RPC.GetResource;
  try {
    details = await caller.getResource(resourceId);
  } catch {
    throw new PostgresRequestError(400, 'PostgreSQL resource is invalid');
  }
  if (
    !isResource(details?.resource) ||
    details.resource.id !== resourceId ||
    details.resource.manager !== managerId ||
    details.resource.type !== 'postgres' ||
    details.resource.name !== 'postgres' ||
    details.resource.external
  ) {
    throw new PostgresRequestError(400, 'PostgreSQL resource is invalid');
  }
  await readInstallation(caller, details.resource);
  return details.resource;
}
