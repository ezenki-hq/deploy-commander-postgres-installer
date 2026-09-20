import type { RunProgress } from '../platform/runTracker';

export function ProgressPanel({ progress }: { progress: RunProgress }) {
  const text =
    progress.phase === 'starting'
      ? 'Starting'
      : progress.phase[0].toUpperCase() + progress.phase.slice(1);
  return (
    <section
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-indigo-950 shadow-sm"
    >
      <h2 className="text-sm font-semibold">{text} PostgreSQL operation</h2>
      {'message' in progress && progress.message && (
        <p className="mt-1 text-sm text-indigo-800">{progress.message}</p>
      )}
    </section>
  );
}
