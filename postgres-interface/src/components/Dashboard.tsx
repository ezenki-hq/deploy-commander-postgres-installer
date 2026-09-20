import type { DashboardProjection } from '../platform/dashboardProjection';
import { ActionButton } from './ActionButton';

export interface DashboardProps {
  projection: DashboardProjection;
  onInstall: () => void;
  onTeardown: () => void;
  busy: boolean;
  error?: string | null;
  onRetry?: () => void;
}

function pluralizeConnections(count: number): string {
  return `${count} managed connection${count === 1 ? '' : 's'}`;
}

export function Dashboard({
  projection,
  onInstall,
  onTeardown,
  busy,
  error,
  onRetry,
}: DashboardProps) {
  return (
    <div className="space-y-6">
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{error}</span>
            {onRetry && (
              <ActionButton tone="secondary" onClick={onRetry}>
                Retry
              </ActionButton>
            )}
          </div>
        </div>
      )}

      {projection.installation.kind === 'conflict' ? (
        <section className="rounded-2xl border border-rose-200 bg-white p-6 shadow-sm sm:p-8">
          <span className="inline-flex rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700">
            Attention required
          </span>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight text-slate-950">
            Multiple PostgreSQL resources found
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
            PostgreSQL installation state is ambiguous. Remove the duplicate resource before running
            another lifecycle action.
          </p>
        </section>
      ) : projection.installation.kind === 'not-installed' ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
            Not installed
          </span>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight text-slate-950">
            Install PostgreSQL
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
            Install the managed PostgreSQL service. Clicking Install authorizes this lifecycle run;
            no second confirmation is required.
          </p>
          <div className="mt-7">
            <ActionButton onClick={onInstall} busy={busy}>
              Install PostgreSQL
            </ActionButton>
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-emerald-200 bg-white p-6 shadow-sm sm:p-8">
          <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
            Installed
          </span>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight text-slate-950">
            PostgreSQL is ready
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            The managed service is installed and available to approved consumers.
          </p>
          <div className="mt-6 rounded-xl bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">
            {pluralizeConnections(projection.connectionCount)}
          </div>
          <div className="mt-7">
            <ActionButton tone="danger" onClick={onTeardown} busy={busy}>
              Teardown PostgreSQL
            </ActionButton>
          </div>
        </section>
      )}
    </div>
  );
}
