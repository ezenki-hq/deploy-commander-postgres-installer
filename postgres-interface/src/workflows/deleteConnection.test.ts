import type { RPC } from "@ezenki/deploy-commander-installer-interface";
import { describe, expect, it, vi } from "vitest";
import type { AccessRequest } from "../domain/requests";
import type { PostgresConnection } from "../platform/connections";
import type { PostgresInstallation } from "../platform/resources";
import { deferred } from "../test/fakes";
import type { DeleteApprovalDecision, DeleteConnectionDeps } from "./deleteConnection";
import { deletePostgresConnection } from "./deleteConnection";

const resource: RPC.ResourceItem = { id: "resource-1", manager: "postgres-manager", agent: "agent-1", type: "postgres", name: "postgres", external: false, created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" };
const installation: PostgresInstallation = { resource, administrator: { username: `dc_admin_${"a".repeat(32)}`, password: "admin-secret" }, platformConnection: { type: "Platform", data: { network: "postgres-network" } } };
const explicitRequest = { currentManagerId: "postgres-manager", callingManagerId: "consumer-1", metadata: { action: "delete-connection" as const, connectionId: "target" } };
const selectionRequest = { ...explicitRequest, metadata: { action: "delete-connection" as const, connectionId: null } };
const access: AccessRequest = { scope: "database", operation: "create", database: "orders" };
const labels = { team: "payments", "postgres.access": "database", "postgres.database": "orders", "postgres.database-origin": "managed" };
const item = (id: string, manager = "consumer-1", connectionLabels: Record<string, string> = labels): RPC.ConnectionItem => ({ id, manager, resource: resource.id, external: false, created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z", labels: connectionLabels });
const target = (id = "target", manager = "consumer-1", targetAccess: AccessRequest = access, connectionLabels: Record<string, string> = labels): PostgresConnection => ({ item: item(id, manager, connectionLabels), managerId: manager, resourceId: resource.id, authority: targetAccess.scope === "database" ? { access: "database", database: targetAccess.database, origin: "managed" } : { access: "full" }, access: targetAccess, username: `dc_user_${"b".repeat(32)}`, password: "connection-secret", platformConnection: installation.platformConnection, metadata: { access: targetAccess, username: `dc_user_${"b".repeat(32)}`, password: "connection-secret", platform_connection: installation.platformConnection } });
const details = (connection: PostgresConnection): RPC.GetConnection => ({ connection: connection.item, config: { id: connection.item.id, manager: connection.managerId, resource: connection.resourceId, metadata: connection.metadata } });

function createDeps(connections: PostgresConnection[] = [target()], overrides: Partial<DeleteConnectionDeps> = {}) {
  const approval = vi.fn(async (): Promise<DeleteApprovalDecision> => ({ allowed: true, connectionId: connections[0]?.item.id ?? "target" }));
  let detailCalls = 0;
  const caller = {
    getMyResources: vi.fn().mockResolvedValue({ items: [resource], limit: 50, offset: 0, total: 1 }),
    getResource: vi.fn().mockResolvedValue({ resource, config: { id: resource.id, manager: resource.manager, agent: "agent-1", resource_type: "postgres", name: "postgres", metadata: { engine: "postgres", version: "15", administrator: installation.administrator }, platform_connection: installation.platformConnection } }),
    getConnections: vi.fn().mockResolvedValue({ items: connections.map((c) => c.item), limit: 50, offset: 0, total: connections.length }),
    getConnection: vi.fn((id: string) => { detailCalls += 1; const found = connections.find((c) => c.item.id === id); return detailCalls > connections.length * 2 ? Promise.reject(new Error("404")) : found ? Promise.resolve(details(found)) : Promise.reject(new Error("404")); }),
    start: vi.fn(),
    deleteConnection: vi.fn(),
  } as unknown as DeleteConnectionDeps["caller"];
  const deps: DeleteConnectionDeps = {
    caller,
    requestApproval: approval,
    runTracker: { startAndWait: vi.fn().mockResolvedValue({ run: { status: 2 }, config: {} }), dispose: vi.fn() },
    databaseOwnerRole: vi.fn(async () => `dc_db_${"d".repeat(32)}`),
    signal: new AbortController().signal,
    ...overrides,
  };
  return { deps, caller, approval: deps.requestApproval as typeof approval };
}

describe("deletePostgresConnection", () => {
  it("does not start cleanup or delete a record before confirmation", async () => {
    const gate = deferred<DeleteApprovalDecision>();
    const { deps, caller, approval } = createDeps([target()], { requestApproval: vi.fn(() => gate.promise) });
    const pending = deletePostgresConnection(deps, explicitRequest);
    await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
    expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
    expect(caller.deleteConnection).not.toHaveBeenCalled();
    gate.resolve({ allowed: false });
    await expect(pending).rejects.toMatchObject({ status: 499 });
  });

  it("shows only connections owned by the trusted caller", async () => {
    const gate = deferred<DeleteApprovalDecision>();
    const callerTarget = target("caller");
    const other = target("other", "other-manager");
    const { deps, approval } = createDeps([callerTarget, other], { requestApproval: vi.fn(() => gate.promise) });
    const pending = deletePostgresConnection(deps, selectionRequest);
    await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
    expect(approval).toHaveBeenCalledWith(expect.objectContaining({ choices: [expect.objectContaining({ id: "caller" })] }));
    gate.resolve({ allowed: false });
    await expect(pending).rejects.toMatchObject({ status: 499 });
  });

  it.each([
    [target("managed"), [], "role-and-database"],
    [target("existing", "consumer-1", { scope: "database", operation: "existing", database: "warehouse" }, { "postgres.access": "database", "postgres.database": "warehouse", "postgres.database-origin": "existing" }), [], "role-only"],
    [target("full", "consumer-1", { scope: "full", superuser: false }, { "postgres.access": "full" }), [], "role-only"],
    [target("peer-target"), [target("peer")], "role-only"],
  ] as const)("computes cleanup effect %s", async (subject, peers, effect) => {
    const { deps } = createDeps([subject, ...peers]);
    await deletePostgresConnection(deps, { ...explicitRequest, metadata: { ...explicitRequest.metadata, connectionId: subject.item.id } });
    expect(deps.runTracker.startAndWait).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ services: expect.any(Object) }) }), expect.any(Function), expect.any(AbortSignal));
    if (effect === "role-and-database") expect(deps.databaseOwnerRole).toHaveBeenCalledWith(resource.id, "orders");
  });

  it("includes a peer beyond the first page in the cleanup decision", async () => {
    const peers = Array.from({ length: 50 }, (_, i) => target(`peer-${i}`));
    const subject = target("target");
    const { deps, caller } = createDeps([subject, ...peers]);
    caller.getConnections = vi.fn()
      .mockResolvedValueOnce({ items: [subject.item, ...peers.slice(0, 49).map((c) => c.item)], limit: 50, offset: 0, total: 51 })
      .mockResolvedValueOnce({ items: [peers[49].item], limit: 50, offset: 50, total: 51 })
      .mockResolvedValueOnce({ items: [subject.item, ...peers.slice(0, 49).map((c) => c.item)], limit: 50, offset: 0, total: 51 })
      .mockResolvedValueOnce({ items: [peers[49].item], limit: 50, offset: 50, total: 51 });
    await deletePostgresConnection(deps, explicitRequest);
    expect(deps.runTracker.startAndWait).toHaveBeenCalled();
  });

  it("fails 409 before starting when the approved cleanup consequence changes", async () => {
    const gate = deferred<DeleteApprovalDecision>();
    const subject = target();
    const peer = target("peer");
    const { deps, caller, approval } = createDeps([subject, peer], { requestApproval: vi.fn(() => gate.promise) });
    const pending = deletePostgresConnection(deps, explicitRequest);
    await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
    caller.getConnections = vi.fn().mockResolvedValue({ items: [subject.item], limit: 50, offset: 0, total: 1 });
    gate.resolve({ allowed: true, connectionId: subject.item.id });
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
  });

  it("rejects malformed labels and never drops the database", async () => {
    const malformed = target("target", "consumer-1", access, { "postgres.access": "database", "postgres.database": "orders" });
    const { deps } = createDeps([malformed]);
    await expect(deletePostgresConnection(deps, explicitRequest)).rejects.toMatchObject({ status: 409 });
    expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
  });
});
