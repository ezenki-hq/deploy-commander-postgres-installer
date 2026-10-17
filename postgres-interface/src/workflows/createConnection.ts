import type { RPC, RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import {
  databaseOwnerRole as defaultDatabaseOwnerRole,
  generateLoginCredentials as defaultGenerateLoginCredentials,
  type LoginCredentials,
} from '../domain/credentials';
import { PostgresRequestError } from '../domain/errors';
import { databaseOrigin, type DatabaseOrigin } from '../domain/labels';
import type { AccessRequest, ParsedCreateRequest } from '../domain/requests';
import {
  findCompatibleConnection,
  listResourceConnectionSummaries,
  listResourceConnections,
  type PostgresConnection,
} from '../platform/connections';
import { buildProvisionPlan, RUNNER_IMAGE } from '../platform/plans';
import {
  readInstallation,
  resolveOwnedPostgresResource,
  type PostgresInstallation,
} from '../platform/resources';
import { RunFailedError, type RunProgress, type RunTracker } from '../platform/runTracker';

const POST_RUN_PERSISTENCE_TIMEOUT_MS = 5_000;
const POST_RUN_PERSISTENCE_POLL_MS = 250;

export type CreateApprovalContext = {
  callingManagerId: string;
  requestedAccess: AccessRequest | null;
  callerLabels: Record<string, string>;
  databaseNames: string[];
};

export type CreateApprovalDecision = { allowed: false } | { allowed: true; access: AccessRequest };

export type CreateConnectionRequest = {
  currentManagerId: string;
  callingManagerId: string;
  metadata: ParsedCreateRequest;
};

export type CreateConnectionDeps = {
  caller: RPCCaller;
  requestApproval: (context: CreateApprovalContext) => Promise<CreateApprovalDecision>;
  runTracker: RunTracker;
  generateLoginCredentials?: typeof defaultGenerateLoginCredentials;
  databaseOwnerRole?: typeof defaultDatabaseOwnerRole;
  signal?: AbortSignal;
  onProgress?: (progress: RunProgress) => void;
};

function assertManagerId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PostgresRequestError(400, `Missing ${label} manager identity`);
  }
}

function connectionResult(connection: PostgresConnection): { connection: RPC.ConnectionItem } {
  return { connection: connection.item };
}

function sameIdentity(
  connection: PostgresConnection,
  access: AccessRequest,
  callerId: string,
  resourceId: string,
  groupId?: string,
): boolean {
  if (connection.managerId !== callerId || connection.resourceId !== resourceId) return false;
  if ((connection.item.labels?.custom_deployer_group_id ?? undefined) !== groupId) return false;
  if (access.scope === 'database') {
    return connection.access.scope === 'database' && connection.access.database === access.database;
  }
  return connection.access.scope === 'full' && connection.access.superuser === access.superuser;
}

function selectOrigin(
  access: AccessRequest,
  peers: PostgresConnection[],
): DatabaseOrigin | undefined {
  if (access.scope !== 'database') return undefined;
  return databaseOrigin(
    access.operation,
    access.database,
    peers.map((peer) => peer.authority),
  );
}

function runFailure(error: RunFailedError): PostgresRequestError {
  if (error.marker === 'database-not-found')
    return new PostgresRequestError(404, 'The requested PostgreSQL database was not found');
  if (error.marker === 'database-collision')
    return new PostgresRequestError(
      409,
      'The PostgreSQL database already exists outside manager ownership',
    );
  if (error.marker === 'postgres-unavailable')
    return new PostgresRequestError(500, 'PostgreSQL is installed but unavailable');
  return new PostgresRequestError(500, 'PostgreSQL connection creation failed');
}

function signalFor(deps: CreateConnectionDeps): AbortSignal {
  return deps.signal ?? new AbortController().signal;
}

async function installedState(
  caller: RPCCaller,
  currentManagerId: string,
  resourceId: string,
): Promise<{ installation: PostgresInstallation; summaries: RPC.ConnectionItem[] }> {
  const resource = await resolveOwnedPostgresResource(caller, currentManagerId, resourceId);
  const installation = await readInstallation(caller, resource);
  const summaries = await listResourceConnectionSummaries(caller, resource.id);
  return { installation, summaries };
}

export async function createPostgresConnection(
  deps: CreateConnectionDeps,
  request: CreateConnectionRequest,
): Promise<{ connection: RPC.ConnectionItem }> {
  assertManagerId(request.currentManagerId, 'current');
  assertManagerId(request.callingManagerId, 'calling');
  if (request.metadata.action !== 'create-connection')
    throw new PostgresRequestError(400, 'Unsupported PostgreSQL action');
  if (typeof request.metadata.resourceId !== 'string' || request.metadata.resourceId.trim() === '')
    throw new PostgresRequestError(400, 'PostgreSQL resource is required');

  const initial = await installedState(
    deps.caller,
    request.currentManagerId,
    request.metadata.resourceId,
  );
  const databaseNames = [
    ...new Set(
      initial.summaries
        .map((item) => item.labels?.['postgres.database'])
        .filter((name): name is string => typeof name === 'string'),
    ),
  ].sort();
  const decision = await deps.requestApproval({
    callingManagerId: request.callingManagerId,
    requestedAccess: request.metadata.requestedAccess,
    callerLabels: request.metadata.labels,
    databaseNames,
  });
  if (!decision.allowed)
    throw new PostgresRequestError(499, 'PostgreSQL connection approval was rejected');

  const access = decision.access;
  const refreshed = await installedState(
    deps.caller,
    request.currentManagerId,
    request.metadata.resourceId,
  );
  const peers = await listResourceConnections(deps.caller, refreshed.installation.resource.id);
  const origin = selectOrigin(access, peers);
  const expectedLabels = request.metadata.labels;
  const groupId = expectedLabels.custom_deployer_group_id;
  const lookup = findCompatibleConnection(peers, {
    managerId: request.callingManagerId,
    resourceId: refreshed.installation.resource.id,
    access,
    labels: expectedLabels,
    groupId,
  });
  if (lookup.kind === 'match') return connectionResult(lookup.connection);
  if (
    peers.some((peer) =>
      sameIdentity(
        peer,
        access,
        request.callingManagerId,
        refreshed.installation.resource.id,
        groupId,
      ),
    )
  ) {
    throw new PostgresRequestError(
      409,
      'A PostgreSQL connection with this identity is incompatible',
    );
  }

  const generateLoginCredentials = deps.generateLoginCredentials ?? defaultGenerateLoginCredentials;
  const login: LoginCredentials = await generateLoginCredentials({
    callerId: request.callingManagerId,
    resourceId: refreshed.installation.resource.id,
    groupId,
    access,
  });
  const databaseOwner =
    access.scope === 'database'
      ? await (deps.databaseOwnerRole ?? defaultDatabaseOwnerRole)(
          refreshed.installation.resource.id,
          access.database,
        )
      : undefined;
  const plan = buildProvisionPlan({
    installation: refreshed.installation,
    callerId: request.callingManagerId,
    access,
    origin,
    databaseOwner,
    callerLabels: expectedLabels,
  });

  try {
    await deps.runTracker.startAndWait(
      {
        action: 'create-connection',
        runner: RUNNER_IMAGE,
        note: 'PostgreSQL connection provisioning',
        target: { kind: 'resource', id: refreshed.installation.resource.id },
        metadata: plan,
        secrets: { USERNAME: login.username, PASSWORD: login.password },
      },
      deps.onProgress ?? (() => undefined),
      signalFor(deps),
    );
  } catch (error) {
    if (error instanceof RunFailedError) throw runFailure(error);
    throw new PostgresRequestError(500, 'PostgreSQL connection creation failed');
  }

  const persistenceDeadline = Date.now() + POST_RUN_PERSISTENCE_TIMEOUT_MS;
  while (true) {
    const completed = await listResourceConnections(
      deps.caller,
      refreshed.installation.resource.id,
    );
    const result = findCompatibleConnection(completed, {
      managerId: request.callingManagerId,
      resourceId: refreshed.installation.resource.id,
      access,
      labels: expectedLabels,
      groupId,
    });
    if (result.kind === 'match') return connectionResult(result.connection);
    if (result.kind === 'conflict')
      throw new PostgresRequestError(409, 'Multiple PostgreSQL connections match the request');
    if (
      completed.some((connection) =>
        sameIdentity(
          connection,
          access,
          request.callingManagerId,
          refreshed.installation.resource.id,
          groupId,
        ),
      )
    )
      throw new PostgresRequestError(
        500,
        'PostgreSQL connection was persisted with incompatible settings',
      );
    if (Date.now() >= persistenceDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, POST_RUN_PERSISTENCE_POLL_MS));
  }
  throw new PostgresRequestError(500, 'PostgreSQL connection was not persisted');
}
