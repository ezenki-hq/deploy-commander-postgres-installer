import type { HTMLAttributes, ReactNode } from 'react';

export type StatusTone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

export interface StatusPanelProps extends Pick<HTMLAttributes<HTMLElement>, 'role'> {
  tone: StatusTone;
  title: string;
  eyebrow?: string;
  badge?: string;
  children: ReactNode;
  actions?: ReactNode;
}

const panelClasses: Record<StatusTone, string> = {
  neutral: 'border-slate-200 bg-white',
  progress: 'border-indigo-200 bg-white',
  success: 'border-emerald-200 bg-white',
  warning: 'border-amber-200 bg-white',
  danger: 'border-rose-200 bg-white',
};
const eyebrowClasses: Record<StatusTone, string> = {
  neutral: 'text-slate-600',
  progress: 'text-indigo-700',
  success: 'text-emerald-700',
  warning: 'text-amber-800',
  danger: 'text-rose-700',
};

export default function StatusPanel({
  tone,
  title,
  eyebrow,
  badge,
  children,
  actions,
  role,
}: StatusPanelProps) {
  return (
    <section
      role={role}
      aria-live={role === 'status' ? 'polite' : undefined}
      className={`rounded-2xl border p-5 shadow-sm sm:p-7 ${panelClasses[tone]}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <p className={`text-xs font-bold uppercase tracking-[0.16em] ${eyebrowClasses[tone]}`}>
              {eyebrow}
            </p>
          )}
          <h2 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{title}</h2>
        </div>
        {badge && (
          <span className="w-fit rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            {badge}
          </span>
        )}
      </div>
      <div className="mt-4 text-sm leading-6 text-slate-600">{children}</div>
      {actions && (
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">{actions}</div>
      )}
    </section>
  );
}
