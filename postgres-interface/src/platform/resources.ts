import type { RPC, RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import { PostgresRequestError } from "../domain/errors";

const PAGE_SIZE = 50;
const ADMIN_USERNAME = /^dc_admin_[0-9a-f]{32}$/;

export type InstallationProjection =
  | { kind: "not-installed" }
  | { kind: "installed"; resource: RPC.ResourceItem }
  | { kind: "conflict"; resources: RPC.ResourceItem[] };

export type PostgresInstallation = {
  resource: RPC.ResourceItem;
  administrator: { username: string; password: string };
  platformConnection: { type: "Platform"; data: { network: string } };
};

function isResource(value: unknown): value is RPC.ResourceItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const resource = value as Partial<RPC.ResourceItem>;
  return (
    typeof resource.id === "string" && resource.id.trim() !== "" &&
    typeof resource.manager === "string" && resource.manager.trim() !== "" &&
    typeof resource.type === "string" && resource.type.trim() !== "" &&
    typeof resource.name === "string" && resource.name.trim() !== "" &&
    typeof resource.external === "boolean" &&
    typeof resource.created_at === "string" && resource.created_at.trim() !== "" &&
    typeof resource.updated_at === "string" && resource.updated_at.trim() !== ""
  );
}

function invalidResource(message = "Unable to load PostgreSQL resources"): PostgresRequestError {
  return new PostgresRequestError(500, message);
}

function validPage(value: unknown, offset: number): value is RPC.GetResources {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const page = value as Partial<RPC.GetResources>;
  return (
    Array.isArray(page.items) && page.items.every(isResource) &&
    page.limit === PAGE_SIZE && page.offset === offset &&
    typeof page.total === "number" && Number.isSafeInteger(page.total) && page.total >= 0 &&
    page.items.length <= PAGE_SIZE && page.items.length <= page.total &&
    page.offset >= 0 && page.offset <= page.total &&
    (page.items.length > 0 || page.total === 0 || page.offset >= page.total)
  );
}

export async function listPostgresResources(caller: RPCCaller): Promise<RPC.ResourceItem[]> {
  const resources: RPC.ResourceItem[] = [];
  let offset = 0;
  while (true) {
    let response: unknown;
    try {
      response = await caller.getMyResources("postgres", false, PAGE_SIZE, offset);
    } catch {
      throw invalidResource();
    }
    if (!validPage(response, offset)) throw invalidResource();
    resources.push(...response.items.filter((item) => item.type === "postgres" && item.name === "postgres" && !item.external));
    if (response.items.length === 0 || offset + response.items.length >= response.total) return resources;
    offset += response.items.length;
  }
}

export async function loadInstallationProjection(caller: RPCCaller): Promise<InstallationProjection> {
  const resources = await listPostgresResources(caller);
  if (resources.length === 0) return { kind: "not-installed" };
  if (resources.length > 1) return { kind: "conflict", resources };
  return { kind: "installed", resource: resources[0] };
}

function isPlatformConnection(value: unknown): value is PostgresInstallation["platformConnection"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const connection = value as { type?: unknown; data?: unknown };
  if (connection.type !== "Platform" || typeof connection.data !== "object" || connection.data === null) return false;
  return typeof (connection.data as { network?: unknown }).network === "string" &&
    (connection.data as { network: string }).network.trim() !== "";
}

export async function readInstallation(
  caller: RPCCaller,
  resource: RPC.ResourceItem,
): Promise<PostgresInstallation> {
  let details: RPC.GetResource;
  try {
    details = await caller.getResource(resource.id);
  } catch {
    throw new PostgresRequestError(400, "PostgreSQL resource configuration is invalid");
  }
  const config = details?.config;
  const metadata = config?.metadata;
  const administrator = metadata?.administrator;
  if (
    !isResource(details?.resource) || details.resource.id !== resource.id ||
    details.resource.manager !== resource.manager || details.resource.type !== "postgres" ||
    details.resource.name !== "postgres" || details.resource.external ||
    !config || config.id !== resource.id || config.manager !== resource.manager ||
    typeof config.agent !== "string" || config.agent.trim() === "" || config.resource_type !== "postgres" || config.name !== "postgres" ||
    !metadata || metadata.engine !== "postgres" || metadata.version !== "15" ||
    !administrator || typeof administrator.username !== "string" ||
    !ADMIN_USERNAME.test(administrator.username) || typeof administrator.password !== "string" ||
    administrator.password.trim() === "" || !isPlatformConnection(config.platform_connection)
  ) {
    throw new PostgresRequestError(400, "PostgreSQL resource configuration is invalid");
  }
  return {
    resource,
    administrator: { username: administrator.username, password: administrator.password },
    platformConnection: config.platform_connection,
  };
}
