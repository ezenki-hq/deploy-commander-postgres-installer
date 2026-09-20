import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

const badgeClasses: Record<BadgeTone, string> = {
  neutral: 'border-slate-200 bg-slate-100 text-slate-700',
  progress: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  danger: 'border-rose-200 bg-rose-50 text-rose-700',
};

export function ManagerShell({
  children,
  badge,
}: {
  children: ReactNode;
  badge?: { label: string; tone: BadgeTone };
}) {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">
              Deploy Commander manager
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              PostgreSQL Manager
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Install PostgreSQL once, then approve and manage connections for your services.
            </p>
          </div>
          {badge && (
            <span
              className={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-xs font-semibold ${badgeClasses[badge.tone]}`}
            >
              {badge.label}
            </span>
          )}
        </header>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
