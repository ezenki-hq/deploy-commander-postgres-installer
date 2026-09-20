import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface ModalDialogProps {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  onCancel: () => void;
  busy?: boolean;
  tone?: 'neutral' | 'danger';
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"]):not([aria-disabled="true"])',
    ),
  ).filter((element) => !element.hasAttribute('hidden'));
}

export function ModalDialog({
  title,
  description,
  children,
  actions,
  onCancel,
  busy = false,
  tone = 'neutral',
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const cancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    cancelRef.current = onCancel;
    busyRef.current = busy;
  }, [busy, onCancel]);

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const focusable = () => focusableElements(dialog);
    const first = focusable()[0];
    (first ?? dialog).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (busyRef.current) return;
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };

    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      previousFocus.current?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`w-full max-w-lg rounded-2xl border bg-white p-6 shadow-2xl outline-none sm:p-7 ${tone === 'danger' ? 'border-rose-200' : 'border-slate-200'}`}
      >
        <h2 id={titleId} className="text-xl font-semibold tracking-tight text-slate-950">
          {title}
        </h2>
        {description && (
          <div id={descriptionId} className="mt-2 text-sm leading-6 text-slate-600">
            {description}
          </div>
        )}
        <div className="mt-5 space-y-4 text-sm text-slate-700">{children}</div>
        <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">{actions}</div>
      </div>
    </div>
  );
}
