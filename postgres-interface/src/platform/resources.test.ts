import type { RPC } from "@ezenki/deploy-commander-installer-interface";
import { describe, expect, it, vi } from "vitest";
import { fakeCaller } from "../test/fakes";
import { loadInstallationProjection, readInstallation } from "./resources";

const resource = (id: string, overrides: Partial<RPC.ResourceItem> = {}): RPC.ResourceItem => ({
  id,
  manager: "postgres-manager",
  agent: "agent-1",
  type: "postgres",
  name: "postgres",
  external: false,
  created_at: "2026-09-20T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
  ...overrides,
});

const postgresResource = resource("resource-1");

const resourcePage = (items: RPC.ResourceItem[], offset: number, total = items.length) => ({
  items,
  limit: 50,
  offset,
  total,
});

describe("loadInstallationProjection", () => {
  it("returns not-installed when no stable resource exists", async () => {
    const caller = fakeCaller({
      getMyResources: vi.fn().mockResolvedValue(resourcePage([], 0, 0)),
    });
    await expect(loadInstallationProjection(caller)).resolves.toEqual({ kind: "not-installed" });
  });

  it("loads every page before selecting the stable postgres resource", async () => {
    const otherResources = Array.from({ length: 49 }, (_, index) => resource(`other-${index}`, { type: "other", name: `other-${index}` }));
    const caller = fakeCaller({
      getMyResources: vi.fn()
        .mockResolvedValueOnce(resourcePage([...otherResources, postgresResource], 0, 51))
        .mockResolvedValueOnce(resourcePage([resource("last-other", { type: "other", name: "last-other" })], 50, 51)),
    });
    const projection = await loadInstallationProjection(caller);
    expect(projection).toEqual({ kind: "installed", resource: postgresResource });
    expect(caller.getMyResources).toHaveBeenNthCalledWith(2, "postgres", false, 50, 50);
  });

  it("reports a concrete conflict for two stable resources", async () => {
    const caller = fakeCaller({
      getMyResources: vi.fn().mockResolvedValue(resourcePage([postgresResource, resource("resource-2")], 0, 2)),
    });
    await expect(loadInstallationProjection(caller)).resolves.toEqual({
      kind: "conflict",
      resources: [postgresResource, resource("resource-2")],
    });
  });
});

describe("readInstallation", () => {
  it("reads administrator credentials and the exact platform connection", async () => {
    const caller = fakeCaller({
      getResource: vi.fn().mockResolvedValue({
        resource: postgresResource,
        config: {
          id: postgresResource.id,
          manager: postgresResource.manager,
          agent: "agent-1",
          resource_type: "postgres",
          name: "postgres",
          metadata: {
            engine: "postgres",
            version: "15",
            administrator: { username: "dc_admin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", password: "admin-secret" },
          },
          platform_connection: { type: "Platform", data: { network: "postgres-network" } },
        },
      }),
    });
    await expect(readInstallation(caller, postgresResource)).resolves.toEqual({
      resource: postgresResource,
      administrator: { username: "dc_admin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", password: "admin-secret" },
      platformConnection: { type: "Platform", data: { network: "postgres-network" } },
    });
  });

  it("rejects malformed resource configuration with a concrete 400", async () => {
    const caller = fakeCaller({
      getResource: vi.fn().mockResolvedValue({ resource: postgresResource, config: {} }),
    });
    await expect(readInstallation(caller, postgresResource)).rejects.toMatchObject({ status: 400 });
  });
});
