import type { RunProgress } from "../platform/runTracker";

export function ProgressPanel({ progress }: { progress: RunProgress }) {
  const text = progress.phase === "starting" ? "Starting" : progress.phase[0].toUpperCase() + progress.phase.slice(1);
  return <section aria-live="polite" className="progress-panel"><h2>{text} PostgreSQL operation</h2>{"message" in progress && progress.message && <p>{progress.message}</p>}</section>;
}
