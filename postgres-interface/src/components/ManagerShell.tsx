import type { ReactNode } from 'react';

export type ShellBadgeTone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

export interface ManagerShellProps {
  children: ReactNode;
  badge?: { label: string; tone: ShellBadgeTone };
}

const badgeClasses: Record<ShellBadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  progress: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  danger: 'bg-rose-50 text-rose-700 ring-rose-200',
};

export default function ManagerShell({ children, badge }: ManagerShellProps) {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 sm:py-10 lg:px-8">
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">
              Deploy Commander
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              PostgreSQL manager
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Manage the shared PostgreSQL service and its logical database connections.
            </p>
          </div>
          {badge && (
            <span
              className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset ${badgeClasses[badge.tone]}`}
            >
              {badge.label}
            </span>
          )}
        </header>
        {children}
      </div>
    </main>
  );
}
