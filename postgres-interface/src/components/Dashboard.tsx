import { useEffect, useState } from "react";
import type { RPCCaller } from "@ezenki/deploy-commander-installer-interface";
import { listResourceConnectionSummaries } from "../platform/connections";
import { loadInstallationProjection, type InstallationProjection } from "../platform/resources";

export function Dashboard({ caller, onInstall, onTeardown, busy = false }: { caller: RPCCaller; onInstall: () => void; onTeardown: () => void; busy?: boolean }) {
  const [projection, setProjection] = useState<InstallationProjection | null>(null);
  const [connectionCount, setConnectionCount] = useState(0);
  useEffect(() => { let live = true; void (async () => { const next = await loadInstallationProjection(caller); if (!live) return; setProjection(next); if (next.kind === "installed") setConnectionCount((await listResourceConnectionSummaries(caller, next.resource.id)).length); })().catch(() => live && setProjection({ kind: "not-installed" })); return () => { live = false; }; }, [caller]);
  if (!projection) return <main><h1>PostgreSQL Manager</h1><p>Loading PostgreSQL state…</p></main>;
  if (projection.kind === "conflict") return <main><h1>PostgreSQL Manager</h1><p role="alert">Multiple PostgreSQL resources need attention.</p></main>;
  if (projection.kind === "not-installed") return <main><h1>PostgreSQL Manager</h1><p>PostgreSQL is not installed.</p><button type="button" onClick={onInstall} disabled={busy}>Install PostgreSQL</button></main>;
  return <main><h1>PostgreSQL Manager</h1><p>PostgreSQL is installed.</p><p>{connectionCount} managed connection{connectionCount === 1 ? "" : "s"}.</p><button type="button" onClick={onTeardown} disabled={busy}>Teardown PostgreSQL</button></main>;
}
