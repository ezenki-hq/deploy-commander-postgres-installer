import type { RPC, RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import { PostgresRequestError } from '../domain/errors';
import type { ParsedLinkRequest, ParsedUnlinkRequest } from '../domain/requests';
import { listResourceConnectionSummaries, readPostgresConnection } from '../platform/connections';
import { resolveOwnedPostgresResource } from '../platform/resources';

const GROUP_ID = 'custom_deployer_group_id';
const ORIGIN = 'custom_deployer_connection_origin';

async function targetConnection(
  caller: RPCCaller,
  resourceId: string,
  connectionId: string,
): Promise<RPC.ConnectionItem> {
  const connections = await listResourceConnectionSummaries(caller, resourceId);
  const target = connections.find((connection) => connection.id === connectionId);
  if (!target) throw new PostgresRequestError(404, 'PostgreSQL connection was not found on this resource');
  await readPostgresConnection(caller, target);
  return target;
}

async function freshConnection(
  caller: RPCCaller,
  expected: RPC.ConnectionItem,
): Promise<RPC.ConnectionItem> {
  let details: RPC.GetConnection;
  try {
    details = await caller.getConnection(expected.id, { include_labels: true });
  } catch {
    throw new PostgresRequestError(500, 'Unable to verify PostgreSQL connection labels');
  }
  const connection = details?.connection;
  if (
    !connection ||
    connection.id !== expected.id ||
    connection.manager !== expected.manager ||
    connection.resource !== expected.resource ||
    !connection.labels
  ) {
    throw new PostgresRequestError(500, 'Unable to verify PostgreSQL connection labels');
  }
  await readPostgresConnection(caller, connection);
  return connection;
}

async function setLabel(caller: RPCCaller, id: string, key: string, value: string): Promise<void> {
  try {
    await caller.setConnectionLabel(id, key, value);
  } catch {
    throw new PostgresRequestError(500, 'Unable to update PostgreSQL connection labels');
  }
}

async function removeLabel(caller: RPCCaller, id: string, key: string): Promise<void> {
  try {
    await caller.removeConnectionLabel(id, key);
  } catch {
    throw new PostgresRequestError(500, 'Unable to update PostgreSQL connection labels');
  }
}

export async function linkPostgresConnection(
  caller: RPCCaller,
  currentManagerId: string,
  request: ParsedLinkRequest,
): Promise<{ connection: RPC.ConnectionItem }> {
  const resource = await resolveOwnedPostgresResource(caller, currentManagerId, request.resourceId);
  const target = await targetConnection(caller, resource.id, request.connectionId);
  const groupId = request.labels[GROUP_ID];
  const origin = request.labels[ORIGIN];
  const labels = target.labels ?? {};
  const currentGroup = labels[GROUP_ID];
  const currentOrigin = labels[ORIGIN];
  if (currentOrigin === 'created' || (currentGroup !== undefined && currentGroup !== groupId)) {
    throw new PostgresRequestError(409, 'PostgreSQL connection cannot be linked to this group');
  }
  if (currentOrigin !== undefined && currentOrigin !== 'imported') {
    throw new PostgresRequestError(409, 'PostgreSQL connection has an invalid group origin');
  }
  if (currentOrigin !== 'imported') await setLabel(caller, target.id, ORIGIN, origin);
  if (currentGroup !== groupId) await setLabel(caller, target.id, GROUP_ID, groupId);
  const verified = await freshConnection(caller, target);
  if (verified.labels?.[GROUP_ID] !== groupId || verified.labels?.[ORIGIN] !== 'imported') {
    throw new PostgresRequestError(500, 'PostgreSQL connection link was not persisted');
  }
  return { connection: verified };
}

export async function unlinkPostgresConnection(
  caller: RPCCaller,
  currentManagerId: string,
  request: ParsedUnlinkRequest,
): Promise<{ connection: RPC.ConnectionItem }> {
  const resource = await resolveOwnedPostgresResource(caller, currentManagerId, request.resourceId);
  const target = await targetConnection(caller, resource.id, request.connectionId);
  const labels = target.labels ?? {};
  const currentGroup = labels[GROUP_ID];
  const origin = labels[ORIGIN];
  if (origin === 'created')
    throw new PostgresRequestError(409, 'PostgreSQL connections created by this manager cannot be unlinked');
  if (currentGroup !== undefined && currentGroup !== request.groupId)
    throw new PostgresRequestError(409, 'PostgreSQL connection belongs to another group');
  if (origin !== undefined && origin !== 'imported')
    throw new PostgresRequestError(409, 'PostgreSQL connection has an invalid group origin');
  if (currentGroup === request.groupId) await removeLabel(caller, target.id, GROUP_ID);
  if (origin === 'imported') await removeLabel(caller, target.id, ORIGIN);
  const verified = await freshConnection(caller, target);
  if (verified.labels?.[GROUP_ID] !== undefined || verified.labels?.[ORIGIN] !== undefined) {
    throw new PostgresRequestError(500, 'PostgreSQL connection unlink was not persisted');
  }
  return { connection: verified };
}
