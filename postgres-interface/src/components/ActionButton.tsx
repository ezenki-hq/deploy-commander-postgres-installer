import type { ButtonHTMLAttributes } from 'react';

export type ActionTone = 'primary' | 'secondary' | 'danger';

export type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ActionTone;
  busy?: boolean;
};

const toneClasses: Record<ActionTone, string> = {
  primary:
    'border-indigo-600 bg-indigo-600 text-white shadow-sm hover:border-indigo-500 hover:bg-indigo-500 focus-visible:ring-indigo-500',
  secondary:
    'border-slate-300 bg-white text-slate-700 shadow-sm hover:border-slate-400 hover:bg-slate-50 focus-visible:ring-indigo-500',
  danger:
    'border-rose-600 bg-rose-600 text-white shadow-sm hover:border-rose-500 hover:bg-rose-500 focus-visible:ring-rose-500',
};

export function ActionButton({
  tone = 'primary',
  busy = false,
  disabled,
  children,
  type = 'button',
  ...props
}: ActionButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex min-h-10 items-center justify-center rounded-lg border px-4 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${toneClasses[tone]} ${props.className ?? ''}`}
    >
      {busy && (
        <span
          aria-hidden="true"
          className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}
