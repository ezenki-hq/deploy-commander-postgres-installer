import { useState } from 'react';
import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import ActionButton from './ActionButton';
import ConfirmDialog from './ConfirmDialog';
import ManagerShell, { type ShellBadgeTone } from './ManagerShell';
import StatusPanel from './StatusPanel';
import type { PostgresLifecycle } from '../lib/postgresRuns';

export type LifecycleAction = 'install' | 'teardown' | null;

export interface ManagerDashboardProps {
  lifecycle: PostgresLifecycle;
  resource: RPC.ResourceItem | null;
  resourceAmbiguous: boolean;
  /** @deprecated compatibility with older host shells. */
  resourceCompatible?: boolean;
  /** @deprecated compatibility with older host shells. */
  resourceContradiction?: boolean;
  activeAction: LifecycleAction;
  error: string | null;
  onInstall: () => void;
  onTeardown: () => void;
  onRetry: () => void;
}

export default function ManagerDashboard({
  lifecycle,
  resource,
  resourceAmbiguous,
  activeAction,
  error,
  onInstall,
  onTeardown,
  onRetry,
}: ManagerDashboardProps) {
  const [confirmingTeardown, setConfirmingTeardown] = useState(false);
  const [teardownSubmitted, setTeardownSubmitted] = useState(false);
  const busy = activeAction !== null || (lifecycle.kind === 'installed' && lifecycle.operationBusy);
  const hasResource = resource !== null;
  const canTeardown = hasResource && !activeAction;
  const requestTeardown = () => {
    setTeardownSubmitted(false);
    setConfirmingTeardown(true);
  };
  const warning = resourceAmbiguous;

  let badge: { label: string; tone: ShellBadgeTone };
  if (warning || lifecycle.kind === 'installation-failed' || lifecycle.kind === 'teardown-failed')
    badge = { label: 'Attention', tone: 'danger' };
  else if (activeAction === 'install' || lifecycle.kind === 'installing')
    badge = { label: 'Installing', tone: 'progress' };
  else if (activeAction === 'teardown' || lifecycle.kind === 'tearing-down')
    badge = { label: 'Tearing down', tone: 'progress' };
  else if (lifecycle.kind === 'installed') badge = { label: 'Installed', tone: 'success' };
  else badge = { label: 'Not installed', tone: 'neutral' };

  let content;
  if (resourceAmbiguous)
    content = (
      <StatusPanel
        tone="danger"
        eyebrow="Attention required"
        title="PostgreSQL resource state is ambiguous"
        role="alert"
        actions={
          <ActionButton tone="secondary" onClick={onRetry}>
            Retry recovery
          </ActionButton>
        }
      >
        Multiple PostgreSQL resources were found. Teardown and reinstall are required.
      </StatusPanel>
    );
  else if (warning)
    content = (
      <StatusPanel
        tone="danger"
        eyebrow="Attention required"
        title="PostgreSQL resource needs recovery"
        role="alert"
        actions={
          canTeardown ? (
            <ActionButton tone="danger" onClick={requestTeardown}>
              Teardown PostgreSQL
            </ActionButton>
          ) : (
            <ActionButton tone="secondary" onClick={onRetry}>
              Retry recovery
            </ActionButton>
          )
        }
      >
        Multiple PostgreSQL resources were found. Teardown and reinstall are required.
      </StatusPanel>
    );
  else if (activeAction === 'install' || lifecycle.kind === 'installing')
    content = (
      <StatusPanel
        tone="progress"
        eyebrow="Installation in progress"
        title="Installing PostgreSQL"
        role="status"
      >
        The shared service and persistent storage are being prepared. This can take a few minutes.
      </StatusPanel>
    );
  else if (activeAction === 'teardown' || lifecycle.kind === 'tearing-down')
    content = (
      <StatusPanel
        tone="progress"
        eyebrow="Teardown in progress"
        title="Tearing down PostgreSQL"
        role="status"
      >
        The shared service and its logical databases are being removed safely.
      </StatusPanel>
    );
  else if (lifecycle.kind === 'teardown-failed')
    content = (
      <StatusPanel
        tone="danger"
        eyebrow="Teardown failed"
        title="PostgreSQL teardown needs retrying"
        role="alert"
        actions={
          <ActionButton tone="danger" disabled={!canTeardown} onClick={requestTeardown}>
            Retry teardown
          </ActionButton>
        }
      >
        The previous teardown run failed. Retry teardown to remove this installation safely.
      </StatusPanel>
    );
  else if (lifecycle.kind === 'installation-failed')
    content = (
      <StatusPanel
        tone="danger"
        eyebrow="Installation failed"
        title="PostgreSQL installation failed"
        role="alert"
        actions={
          <ActionButton tone="primary" disabled={busy} onClick={onInstall}>
            Install PostgreSQL
          </ActionButton>
        }
      >
        The latest installation run failed. Start a new installation to try again.
      </StatusPanel>
    );
  else if (error)
    content = (
      <StatusPanel
        tone="danger"
        eyebrow="Attention required"
        title="PostgreSQL manager needs attention"
        role="alert"
        actions={
          <ActionButton tone="secondary" disabled={busy} onClick={onRetry}>
            Retry recovery
          </ActionButton>
        }
      >
        {error}
      </StatusPanel>
    );
  else if (lifecycle.kind === 'installed' && resource)
    content = (
      <StatusPanel tone="success" eyebrow="PostgreSQL service" title="PostgreSQL is installed">
        <p>
          {lifecycle.operationBusy
            ? 'A PostgreSQL operation is already in progress.'
            : 'The service is ready for logical database connections.'}
        </p>
        <dl className="mt-5 grid gap-4 rounded-xl bg-slate-50 p-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Resource
            </dt>
            <dd className="mt-1 break-all font-mono text-sm text-slate-800">{resource.id}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Connection approval
            </dt>
            <dd className="mt-1 text-sm text-slate-800">Required for every connection request</dd>
          </div>
        </dl>
        <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-4">
          <h3 className="text-sm font-semibold text-rose-900">Danger zone</h3>
          <p className="mt-1 text-sm text-rose-800">
            Remove the shared service and its logical databases.
          </p>
          <ActionButton tone="danger" className="mt-4" disabled={busy} onClick={requestTeardown}>
            Teardown PostgreSQL
          </ActionButton>
        </div>
      </StatusPanel>
    );
  else
    content = (
      <StatusPanel
        tone="neutral"
        eyebrow="PostgreSQL service"
        title="Install PostgreSQL"
        actions={
          <ActionButton tone="primary" disabled={busy} onClick={onInstall}>
            Install PostgreSQL
          </ActionButton>
        }
      >
        Install a private PostgreSQL service with persistent storage.
      </StatusPanel>
    );
  return (
    <ManagerShell badge={badge}>
      {content}
      {confirmingTeardown && (
        <ConfirmDialog
          busy={teardownSubmitted}
          onCancel={() => {
            if (!teardownSubmitted) setConfirmingTeardown(false);
          }}
          onConfirm={() => {
            if (teardownSubmitted) return;
            setTeardownSubmitted(true);
            onTeardown();
            setConfirmingTeardown(false);
          }}
        />
      )}
    </ManagerShell>
  );
}
