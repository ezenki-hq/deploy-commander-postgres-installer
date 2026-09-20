import type { RPC } from "@ezenki/deploy-commander-installer-interface";
import { describe, expect, it, vi } from "vitest";
import type { InstallationProjection } from "../platform/resources";
import { buildInstallPlan } from "../platform/plans";
import { fakeCaller } from "../test/fakes";
import type { LifecycleDeps } from "./lifecycle";
import { installPostgres, teardownPostgres } from "./lifecycle";

const resource: RPC.ResourceItem = { id: "resource-1", manager: "postgres-manager", agent: "agent-1", type: "postgres", name: "postgres", external: false, created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" };
const administrator = { username: `dc_admin_${"a".repeat(32)}`, password: "admin-secret" };

function lifecycleDeps(overrides: Partial<LifecycleDeps> = {}) {
  const projection: InstallationProjection = { kind: "not-installed" };
  const caller = fakeCaller();
  const reloadProjection = vi.fn(async () => projection);
  const onProgress = vi.fn();
  const requestConfirmation = vi.fn(async () => true);
  const deps: LifecycleDeps = {
    caller,
    loadProjection: reloadProjection,
    reloadProjection,
    requestConfirmation,
    runTracker: { startAndWait: vi.fn().mockResolvedValue({ run: { status: 2 }, config: {} }), dispose: vi.fn() },
    generateAdminCredentials: vi.fn(() => administrator),
    onProgress,
    signal: new AbortController().signal,
    ...overrides,
  };
  return { deps, caller, reloadProjection: deps.reloadProjection as typeof reloadProjection, requestConfirmation: deps.requestConfirmation, onProgress };
}

describe("installPostgres", () => {
  it("starts installation directly when the resource is absent", async () => {
    const { deps, requestConfirmation, onProgress } = lifecycleDeps();
    await installPostgres(deps);
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(deps.runTracker.startAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create", metadata: buildInstallPlan(administrator) }),
      onProgress,
      deps.signal,
    );
  });

  it("does not use active or completed runs to decide installation", async () => {
    const installed: InstallationProjection = { kind: "installed", resource };
    const { deps, caller } = lifecycleDeps({ loadProjection: vi.fn(async (): Promise<InstallationProjection> => installed), reloadProjection: vi.fn(async (): Promise<InstallationProjection> => installed) });
    await expect(installPostgres(deps)).rejects.toMatchObject({ status: 409 });
    expect((caller as unknown as { getLatestRun?: unknown }).getLatestRun).toBeUndefined();
  });
});

describe("teardownPostgres", () => {
  it("cancels teardown without starting a run", async () => {
    const { deps, requestConfirmation } = lifecycleDeps({
      loadProjection: vi.fn(async (): Promise<InstallationProjection> => ({ kind: "installed", resource })),
      requestConfirmation: vi.fn().mockResolvedValue(false),
    });
    await teardownPostgres(deps);
    expect(requestConfirmation).toHaveBeenCalledWith(expect.stringMatching(/all databases/i));
    expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
  });

  it("uses the supported teardown action and exact resource target after confirmation", async () => {
    const { deps, reloadProjection, onProgress } = lifecycleDeps({
      loadProjection: vi.fn(async (): Promise<InstallationProjection> => ({ kind: "installed", resource })),
      reloadProjection: vi.fn(async (): Promise<InstallationProjection> => ({ kind: "not-installed" })),
      requestConfirmation: vi.fn().mockResolvedValue(true),
    });
    await teardownPostgres(deps);
    expect(deps.runTracker.startAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ action: "teardown", metadata: {}, target: { kind: "resource", id: resource.id } }),
      onProgress,
      deps.signal,
    );
    expect(reloadProjection).toHaveBeenCalledOnce();
  });
});
