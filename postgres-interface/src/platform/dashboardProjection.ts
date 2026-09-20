import type { RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import { listResourceConnectionSummaries } from './connections';
import { loadInstallationProjection, type InstallationProjection } from './resources';

export type DashboardProjection = {
  installation: InstallationProjection;
  connectionCount: number;
};

export async function loadDashboardProjection(
  caller: RPCCaller,
  knownInstallation?: InstallationProjection,
): Promise<DashboardProjection> {
  const installation = knownInstallation ?? (await loadInstallationProjection(caller));
  if (installation.kind !== 'installed') return { installation, connectionCount: 0 };
  const connections = await listResourceConnectionSummaries(caller, installation.resource.id);
  return { installation, connectionCount: connections.length };
}
