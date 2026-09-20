import { PostgresRequestError } from "./errors";
import type { AccessRequest } from "./requests";

export type DatabaseOrigin = "managed" | "existing";

export type ConnectionAuthority =
  | { access: "database"; database: string; origin: DatabaseOrigin }
  | { access: "full" };

export type DeletionEffect = "role-only" | "role-and-database";

export type DatabasePeer = {
  access: "database" | "full";
  database?: string;
  origin?: DatabaseOrigin;
};

export type DeletionTarget = DatabasePeer & {
  id: string;
};

const RESERVED_LABELS = new Set([
  "postgres.access",
  "postgres.database",
  "postgres.database-origin",
]);

function assertDatabaseName(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    value.toLowerCase() === "template0" ||
    value.toLowerCase() === "template1" ||
    new TextEncoder().encode(value).byteLength > 63
  ) {
    throw new PostgresRequestError(409, "PostgreSQL connection database labels are invalid");
  }
}

export function connectionLabels(
  access: AccessRequest,
  callerLabels: Record<string, string>,
  origin?: DatabaseOrigin,
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(callerLabels)) {
    if (!key.trim() || RESERVED_LABELS.has(key.trim())) {
      throw new PostgresRequestError(400, "PostgreSQL reserved labels cannot be supplied");
    }
    if (typeof value !== "string") {
      throw new PostgresRequestError(400, "PostgreSQL label values must be strings");
    }
    labels[key] = value;
  }

  if (access.scope === "full") {
    labels["postgres.access"] = "full";
    return labels;
  }

  assertDatabaseName(access.database);
  if (origin !== "managed" && origin !== "existing") {
    throw new PostgresRequestError(400, "PostgreSQL database origin is required");
  }
  labels["postgres.access"] = "database";
  labels["postgres.database"] = access.database;
  labels["postgres.database-origin"] = origin;
  return labels;
}

export function parseConnectionLabels(value: unknown): ConnectionAuthority {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PostgresRequestError(409, "PostgreSQL connection labels are invalid");
  }
  const labels = value as Record<string, unknown>;
  for (const [key, labelValue] of Object.entries(labels)) {
    if (typeof labelValue !== "string") {
      throw new PostgresRequestError(409, "PostgreSQL connection labels are invalid");
    }
    if (RESERVED_LABELS.has(key) && labelValue.trim() === "") {
      throw new PostgresRequestError(409, "PostgreSQL connection labels are invalid");
    }
  }

  if (labels["postgres.access"] === "full") {
    if (labels["postgres.database"] !== undefined || labels["postgres.database-origin"] !== undefined) {
      throw new PostgresRequestError(409, "PostgreSQL connection labels are contradictory");
    }
    return { access: "full" };
  }

  if (labels["postgres.access"] !== "database") {
    throw new PostgresRequestError(409, "PostgreSQL connection labels are invalid");
  }
  assertDatabaseName(labels["postgres.database"]);
  const origin = labels["postgres.database-origin"];
  if (origin !== "managed" && origin !== "existing") {
    throw new PostgresRequestError(409, "PostgreSQL connection labels are invalid");
  }
  return { access: "database", database: labels["postgres.database"], origin };
}

export function databaseOrigin(
  operation: "create" | "existing",
  database: string,
  peers: DatabasePeer[],
): DatabaseOrigin {
  if (operation === "create") return "managed";
  return peers.some(
    (peer) => peer.access === "database" && peer.database === database && peer.origin === "managed",
  )
    ? "managed"
    : "existing";
}

export function deletionEffect(
  target: DeletionTarget,
  peers: DeletionTarget[],
): DeletionEffect {
  if (target.access !== "database" || target.origin !== "managed") return "role-only";
  const hasPeer = peers.some(
    (peer) =>
      peer.id !== target.id &&
      peer.access === "database" &&
      peer.database === target.database,
  );
  return hasPeer ? "role-only" : "role-and-database";
}

export { RESERVED_LABELS };
