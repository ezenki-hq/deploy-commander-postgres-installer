import type { RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import { databaseOwnerRole as defaultDatabaseOwnerRole } from '../domain/credentials';
import { PostgresRequestError, rpcStatus } from '../domain/errors';
import { deletionEffect, type ConnectionAuthority, type DeletionTarget } from '../domain/labels';
import type { AccessRequest, ParsedDeleteRequest } from '../domain/requests';
import {
  listResourceConnectionSummaries,
  listResourceConnections,
  type PostgresConnection,
} from '../platform/connections';
import { buildBatchDeletePlan, buildDeletePlan, RUNNER_IMAGE } from '../platform/plans';
import {
  loadInstallationProjection,
  readInstallation,
  type PostgresInstallation,
} from '../platform/resources';
import type { RunProgress, RunTracker } from '../platform/runTracker';

export type DeleteChoice = {
  id: string;
  access: AccessRequest;
  authority: ConnectionAuthority;
  effect: 'role-only' | 'role-and-database';
};

export type DeleteApprovalContext = {
  callingManagerId: string;
  requestedConnectionId: string | null;
  choices: DeleteChoice[];
};

export type DeleteApprovalDecision = { allowed: false } | { allowed: true; connectionId: string };

export type DeleteConnectionRequest = {
  currentManagerId: string;
  callingManagerId: string;
  metadata: ParsedDeleteRequest;
};

export type DeleteConnectionDeps = {
  caller: RPCCaller;
  requestApproval: (context: DeleteApprovalContext) => Promise<DeleteApprovalDecision>;
  runTracker: RunTracker;
  databaseOwnerRole?: typeof defaultDatabaseOwnerRole;
  signal?: AbortSignal;
  onProgress?: (progress: RunProgress) => void;
};

function assertManagerId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new PostgresRequestError(400, `Missing ${label} manager identity`);
}

function targetOf(connection: PostgresConnection): DeletionTarget {
  return connection.authority.access === 'database'
    ? {
        id: connection.item.id,
        access: 'database',
        database: connection.authority.database,
        origin: connection.authority.origin,
      }
    : { id: connection.item.id, access: 'full' };
}

function fingerprint(connection: PostgresConnection): string {
  return JSON.stringify({
    id: connection.item.id,
    manager: connection.item.manager,
    resource: connection.item.resource,
    labels: connection.item.labels,
    authority: connection.authority,
    access: connection.access,
  });
}

function peerSetFingerprint(connections: PostgresConnection[]): string {
  return connections.map(fingerprint).sort().join('\n');
}

function choiceFor(connection: PostgresConnection, peers: PostgresConnection[]): DeleteChoice {
  return {
    id: connection.item.id,
    access: connection.access,
    authority: connection.authority,
    effect: deletionEffect(targetOf(connection), peers.map(targetOf)),
  };
}

async function installed(
  caller: RPCCaller,
  currentManagerId: string,
): Promise<{ installation: PostgresInstallation; connections: PostgresConnection[] }> {
  const projection = await loadInstallationProjection(caller);
  if (projection.kind === 'not-installed')
    throw new PostgresRequestError(404, 'PostgreSQL is not installed');
  if (projection.kind === 'conflict')
    throw new PostgresRequestError(409, 'Multiple PostgreSQL resources exist');
  if (projection.resource.manager !== currentManagerId)
    throw new PostgresRequestError(400, 'PostgreSQL resource belongs to another manager');
  return {
    installation: await readInstallation(caller, projection.resource),
    connections: await listResourceConnections(caller, projection.resource.id),
  };
}

function signalFor(deps: DeleteConnectionDeps): AbortSignal {
  return deps.signal ?? new AbortController().signal;
}

export async function deletePostgresConnection(
  deps: DeleteConnectionDeps,
  request: DeleteConnectionRequest,
): Promise<{ connection: string } | { connections: string[] }> {
  assertManagerId(request.currentManagerId, 'current');
  assertManagerId(request.callingManagerId, 'calling');
  if (request.metadata.action !== 'delete-connection')
    throw new PostgresRequestError(400, 'Unsupported PostgreSQL action');

  if ('connectionIds' in request.metadata) {
    return {
      connections: await deleteBatchPostgresConnections(
        deps,
        request,
        request.metadata.connectionIds,
      ),
    };
  }

  return {
    connection: await deleteOnePostgresConnection(deps, request, request.metadata.connectionId),
  };
}

async function deleteBatchPostgresConnections(
  deps: DeleteConnectionDeps,
  request: DeleteConnectionRequest,
  requestedIds: string[],
): Promise<string[]> {
  const initial = await installed(deps.caller, request.currentManagerId);
  const requested = requestedIds.map((id) => {
    const target = initial.connections.find((connection) => connection.item.id === id);
    if (!target)
      throw new PostgresRequestError(404, 'A requested PostgreSQL connection was not found');
    if (target.item.labels?.custom_deployer_connection_origin === 'imported')
      throw new PostgresRequestError(
        409,
        'Imported PostgreSQL connections must be unlinked, not deleted',
      );
    return target;
  });
  const requestedSet = new Set(requestedIds);
  const approvedEffects = new Map<string, DeleteChoice>();

  for (const [index, target] of requested.entries()) {
    const remainingPeers = initial.connections.filter(
      (connection) => !requestedIds.slice(0, index).includes(connection.item.id),
    );
    const choice = choiceFor(target, remainingPeers);
    const decision = await deps.requestApproval({
      callingManagerId: request.callingManagerId,
      requestedConnectionId: target.item.id,
      choices: [choice],
    });
    if (!decision.allowed)
      throw new PostgresRequestError(499, 'PostgreSQL connection deletion was rejected');
    if (decision.connectionId !== target.item.id)
      throw new PostgresRequestError(409, 'The selected PostgreSQL connection changed');
    approvedEffects.set(target.item.id, choice);
  }

  const refreshed = await installed(deps.caller, request.currentManagerId);
  if (peerSetFingerprint(refreshed.connections) !== peerSetFingerprint(initial.connections))
    throw new PostgresRequestError(409, 'The PostgreSQL connection set changed after approval');
  const targets = requested.map((before, index) => {
    const target = refreshed.connections.find(
      (connection) => connection.item.id === before.item.id,
    );
    if (!target || fingerprint(target) !== fingerprint(before))
      throw new PostgresRequestError(409, 'The PostgreSQL connection changed after approval');
    const remainingPeers = refreshed.connections.filter(
      (connection) => !requestedIds.slice(0, index).includes(connection.item.id),
    );
    const effect = deletionEffect(targetOf(target), remainingPeers.map(targetOf));
    if (approvedEffects.get(target.item.id)?.effect !== effect)
      throw new PostgresRequestError(
        409,
        'The PostgreSQL cleanup consequence changed after approval',
      );
    return { target, effect };
  });

  const plannedTargets = await Promise.all(
    targets.map(async ({ target, effect }) => ({
      target,
      effect,
      databaseOwner:
        effect === 'role-and-database' && target.authority.access === 'database'
          ? await (deps.databaseOwnerRole ?? defaultDatabaseOwnerRole)(
              target.resourceId,
              target.authority.database,
            )
          : undefined,
    })),
  );
  const plan = buildBatchDeletePlan({
    installation: refreshed.installation,
    targets: plannedTargets,
  });

  try {
    await deps.runTracker.startAndWait(
      {
        action: 'delete-connection',
        runner: RUNNER_IMAGE,
        note: 'PostgreSQL connection cleanup',
        target: { kind: 'resource', id: refreshed.installation.resource.id },
        metadata: plan,
      },
      deps.onProgress ?? (() => undefined),
      signalFor(deps),
    );
  } catch {
    throw new PostgresRequestError(500, 'PostgreSQL connection deletion failed');
  }

  const remaining = await listResourceConnectionSummaries(
    deps.caller,
    refreshed.installation.resource.id,
  );
  if (remaining.some((connection) => requestedSet.has(connection.id)))
    throw new PostgresRequestError(500, 'PostgreSQL connections were not deleted');
  return requestedIds;
}

async function deleteOnePostgresConnection(
  deps: DeleteConnectionDeps,
  request: DeleteConnectionRequest,
  requested: string | null,
): Promise<string> {
  const initial = await installed(deps.caller, request.currentManagerId);
  const owned = initial.connections.filter(
    (connection) =>
      connection.managerId === request.callingManagerId &&
      connection.item.labels?.custom_deployer_connection_origin !== 'imported',
  );
  if (
    requested &&
    initial.connections.some(
      (connection) =>
        connection.item.id === requested &&
        connection.item.labels?.custom_deployer_connection_origin === 'imported',
    )
  ) {
    throw new PostgresRequestError(
      409,
      'Imported PostgreSQL connections must be unlinked, not deleted',
    );
  }
  if (requested && !owned.some((connection) => connection.item.id === requested)) {
    throw new PostgresRequestError(404, 'PostgreSQL connection was not found');
  }
  if (!requested && owned.length === 0)
    throw new PostgresRequestError(404, 'No PostgreSQL connections are available');
  const choices = owned.map((connection) => choiceFor(connection, initial.connections));
  const decision = await deps.requestApproval({
    callingManagerId: request.callingManagerId,
    requestedConnectionId: requested,
    choices,
  });
  if (!decision.allowed)
    throw new PostgresRequestError(499, 'PostgreSQL connection deletion was rejected');
  if (!owned.some((connection) => connection.item.id === decision.connectionId))
    throw new PostgresRequestError(
      409,
      'The selected PostgreSQL connection is not owned by the caller',
    );

  const refreshed = await installed(deps.caller, request.currentManagerId);
  if (peerSetFingerprint(refreshed.connections) !== peerSetFingerprint(initial.connections))
    throw new PostgresRequestError(409, 'The PostgreSQL connection set changed after approval');
  const target = refreshed.connections.find(
    (connection) =>
      connection.item.id === decision.connectionId &&
      connection.managerId === request.callingManagerId,
  );
  const before = owned.find((connection) => connection.item.id === decision.connectionId);
  if (!target || !before || fingerprint(target) !== fingerprint(before))
    throw new PostgresRequestError(409, 'The PostgreSQL connection changed after approval');
  const effect = deletionEffect(targetOf(target), refreshed.connections.map(targetOf));
  const approvedChoice = choices.find((choice) => choice.id === target.item.id);
  if (!approvedChoice || approvedChoice.effect !== effect)
    throw new PostgresRequestError(
      409,
      'The PostgreSQL cleanup consequence changed after approval',
    );

  const databaseOwner =
    effect === 'role-and-database' && target.authority.access === 'database'
      ? await (deps.databaseOwnerRole ?? defaultDatabaseOwnerRole)(
          target.resourceId,
          target.authority.database,
        )
      : undefined;
  const plan = buildDeletePlan({
    installation: refreshed.installation,
    target,
    effect,
    databaseOwner,
  });
  try {
    await deps.runTracker.startAndWait(
      {
        action: 'delete-connection',
        runner: RUNNER_IMAGE,
        note: 'PostgreSQL connection cleanup',
        target: { kind: 'resource', id: refreshed.installation.resource.id },
        metadata: plan,
      },
      deps.onProgress ?? (() => undefined),
      signalFor(deps),
    );
  } catch {
    throw new PostgresRequestError(500, 'PostgreSQL connection deletion failed');
  }

  try {
    const remaining = await deps.caller.getConnection(target.item.id, { include_labels: true });
    if (remaining?.connection?.id === target.item.id)
      throw new PostgresRequestError(500, 'PostgreSQL connection was not deleted');
  } catch (error) {
    if (error instanceof PostgresRequestError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (rpcStatus(error) !== 404 && !/\b404\b|not found/i.test(message)) {
      throw new PostgresRequestError(500, 'Unable to verify PostgreSQL connection deletion');
    }
  }
  return target.item.id;
}
