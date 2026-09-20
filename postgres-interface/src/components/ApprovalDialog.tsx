import { useEffect, useRef, type ReactNode } from "react";

export function ApprovalDialog({ title, children, approveLabel = "Approve", onApprove, onReject, approveDisabled = false }: {
  title: string;
  children: ReactNode;
  approveLabel?: string;
  onApprove: () => void;
  onReject: () => void;
  approveDisabled?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex='0']") ?? [])].filter((el) => !el.hasAttribute("disabled"));
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onReject(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog?.addEventListener("keydown", onKeyDown);
    return () => { dialog?.removeEventListener("keydown", onKeyDown); previousFocus.current?.focus(); };
  }, [onReject]);
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-title" ref={dialogRef}>
    <h2 id="approval-title">{title}</h2>
    <div className="modal-body">{children}</div>
    <div className="modal-actions"><button type="button" onClick={onReject}>Reject</button><button type="button" onClick={onApprove} disabled={approveDisabled}>{approveLabel}</button></div>
  </div></div>;
}
