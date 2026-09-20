import type { RPC, RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import { PostgresRequestError } from "../domain/errors";
import { parseConnectionLabels, type ConnectionAuthority } from "../domain/labels";
import type { AccessRequest } from "../domain/requests";

const PAGE_SIZE = 50;
const USERNAME = /^dc_user_[0-9a-f]{32}$/;

export type PostgresConnection = {
  item: RPC.ConnectionItem;
  managerId: string;
  resourceId: string;
  authority: ConnectionAuthority;
  access: AccessRequest;
  username: string;
  password: string;
  platformConnection: { type: "Platform"; data: { network: string } };
  metadata: Record<string, unknown>;
};

export type ConnectionLookup =
  | { kind: "none" }
  | { kind: "match"; connection: PostgresConnection }
  | { kind: "conflict" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConnection(message = "PostgreSQL connection data is invalid"): PostgresRequestError {
  return new PostgresRequestError(409, message);
}

function parsePlatform(value: unknown): PostgresConnection["platformConnection"] {
  if (!isRecord(value) || value.type !== "Platform" || !isRecord(value.data) ||
      typeof value.data.network !== "string" || value.data.network.trim() === "") {
    throw invalidConnection();
  }
  return { type: "Platform", data: { network: value.data.network } };
}

function parseAccess(value: unknown, authority: ConnectionAuthority): AccessRequest {
  if (!isRecord(value) || (value.scope !== "database" && value.scope !== "full")) {
    throw invalidConnection();
  }
  if (value.scope === "database") {
    if ((value.operation !== "create" && value.operation !== "existing") || typeof value.database !== "string" ||
        authority.access !== "database" || value.database !== authority.database) {
      throw invalidConnection();
    }
    return { scope: "database", operation: value.operation, database: value.database };
  }
  if (typeof value.superuser !== "boolean" || authority.access !== "full") throw invalidConnection();
  return { scope: "full", superuser: value.superuser };
}

function labelsOf(item: RPC.ConnectionItem): Record<string, string> {
  if (!item.labels) throw invalidConnection();
  return item.labels;
}

function validSummary(value: unknown): value is RPC.ConnectionItem {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && value.id.trim() !== "" &&
    typeof value.manager === "string" && value.manager.trim() !== "" &&
    typeof value.resource === "string" && value.resource.trim() !== "" &&
    typeof value.external === "boolean" && typeof value.created_at === "string" &&
    typeof value.updated_at === "string";
}

function validPage(value: unknown, offset: number): value is RPC.GetConnections {
  if (!isRecord(value)) return false;
  const page = value as Partial<RPC.GetConnections>;
  return Array.isArray(page.items) && page.items.every(validSummary) && page.limit === PAGE_SIZE &&
    page.offset === offset && typeof page.total === "number" && Number.isSafeInteger(page.total) &&
    page.total >= 0 && page.items.length <= PAGE_SIZE && page.offset >= 0 &&
    page.offset <= page.total && (page.items.length > 0 || page.total === 0 || page.offset >= page.total);
}

export async function listResourceConnectionSummaries(
  caller: RPCCaller,
  resourceId: string,
): Promise<RPC.ConnectionItem[]> {
  const items: RPC.ConnectionItem[] = [];
  let offset = 0;
  while (true) {
    let response: unknown;
    try {
      response = await caller.getConnections({ limit: PAGE_SIZE, offset, resource: resourceId, include_labels: true });
    } catch {
      throw new PostgresRequestError(500, "Unable to load PostgreSQL connections");
    }
    if (!validPage(response, offset)) throw new PostgresRequestError(500, "Unable to load PostgreSQL connections");
    items.push(...response.items);
    if (response.items.length === 0 || offset + response.items.length >= response.total) return items;
    offset += response.items.length;
  }
}

export async function readPostgresConnection(
  caller: RPCCaller,
  item: RPC.ConnectionItem,
): Promise<PostgresConnection> {
  let details: RPC.GetConnection;
  try {
    details = await caller.getConnection(item.id, { include_labels: true });
  } catch {
    throw invalidConnection();
  }
  const connection = details?.connection;
  const metadata = details?.config?.metadata;
  if (!validSummary(connection) || connection.id !== item.id || connection.manager !== item.manager ||
      connection.resource !== item.resource || !isRecord(metadata)) throw invalidConnection();
  const authority = parseConnectionLabels(labelsOf(connection));
  const access = parseAccess(metadata.access, authority);
  if (typeof metadata.username !== "string" || !USERNAME.test(metadata.username) ||
      typeof metadata.password !== "string" || metadata.password.trim() === "") throw invalidConnection();
  const platformConnection = parsePlatform(metadata.platform_connection);
  return {
    item: connection,
    managerId: connection.manager,
    resourceId: connection.resource,
    authority,
    access,
    username: metadata.username,
    password: metadata.password,
    platformConnection,
    metadata,
  };
}

export async function listResourceConnections(
  caller: RPCCaller,
  resourceId: string,
): Promise<PostgresConnection[]> {
  const summaries = await listResourceConnectionSummaries(caller, resourceId);
  return Promise.all(summaries.map((item) => readPostgresConnection(caller, item)));
}

function sameAccess(left: AccessRequest, right: AccessRequest): boolean {
  if (left.scope !== right.scope) return false;
  return left.scope === "database" && right.scope === "database"
    ? left.database === right.database && left.operation === right.operation
    : left.scope === "full" && right.scope === "full" && left.superuser === right.superuser;
}

function callerLabels(item: RPC.ConnectionItem): Record<string, string> {
  return Object.fromEntries(Object.entries(item.labels ?? {}).filter(([key]) => !key.startsWith("postgres.")));
}

function sameLabels(actual: Record<string, string>, expected: Record<string, string>): boolean {
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return actualKeys.length === expectedKeys.length && expectedKeys.every((key) => actual[key] === expected[key]);
}

export function findCompatibleConnection(
  connections: PostgresConnection[],
  input: { managerId: string; resourceId: string; access: AccessRequest; labels: Record<string, string> },
): ConnectionLookup {
  const matches = connections.filter((connection) =>
    connection.managerId === input.managerId && connection.resourceId === input.resourceId &&
    sameAccess(connection.access, input.access) && sameLabels(callerLabels(connection.item), input.labels));
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "conflict" };
  return { kind: "match", connection: matches[0] };
}
