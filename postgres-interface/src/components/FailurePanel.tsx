export interface FailurePanelProps {
  status: number;
  message: string;
}

export function FailurePanel({ status, message }: FailurePanelProps) {
  return (
    <section
      role="alert"
      className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-rose-900 shadow-sm"
    >
      <p className="text-sm font-semibold">PostgreSQL operation failed ({status})</p>
      <p className="mt-2 text-sm leading-6">{message}</p>
    </section>
  );
}
