import {
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_QUEUED,
  STATUS_RUNNING,
  type Events,
  type RPCCaller,
  type RPC,
  type StartRunOptions,
} from '@ezenki/deploy-commander-installer-interface';

export type RunProgress =
  | { phase: 'starting'; runId: null }
  | { phase: 'queued' | 'running' | 'done' | 'failed'; runId: string; message?: string };

export interface RunEventSource {
  subscribe(listener: (event: Events.InterfaceEvent) => void): () => void;
}

export class RunFailedError extends Error {
  constructor(
    readonly runId: string,
    readonly marker: 'database-not-found' | 'database-collision' | 'postgres-unavailable' | null,
  ) {
    super('PostgreSQL operation failed');
    this.name = 'RunFailedError';
  }
}

export interface RunTracker {
  startAndWait(
    options: StartRunOptions,
    onProgress: (progress: RunProgress) => void,
    signal: AbortSignal,
  ): Promise<RPC.GetRun>;
  dispose(): void;
}

const POLL_MS = 1_000;
const TIMEOUT_MS = 300_000;

function abortError(): Error {
  const error = new Error('PostgreSQL operation aborted');
  error.name = 'AbortError';
  return error;
}

function runStatus(value: unknown): number {
  if (
    value === STATUS_QUEUED ||
    value === STATUS_RUNNING ||
    value === STATUS_DONE ||
    value === STATUS_FAILED
  )
    return value;
  throw new Error('Unknown PostgreSQL run status');
}

function markerFrom(
  message: unknown,
): 'database-not-found' | 'database-collision' | 'postgres-unavailable' | null {
  if (typeof message !== 'string') return null;
  if (message.includes('POSTGRES_MANAGER_ERROR: database-not-found')) return 'database-not-found';
  if (message.includes('POSTGRES_MANAGER_ERROR: database-collision')) return 'database-collision';
  if (message.includes('POSTGRES_MANAGER_ERROR: postgres-unavailable'))
    return 'postgres-unavailable';
  return null;
}

export function createRunTracker(caller: RPCCaller, source: RunEventSource): RunTracker {
  const activeCleanups = new Set<() => void>();

  function startAndWait(
    options: StartRunOptions,
    onProgress: (progress: RunProgress) => void,
    signal: AbortSignal,
  ): Promise<RPC.GetRun> {
    onProgress({ phase: 'starting', runId: null });
    return new Promise<RPC.GetRun>((resolve, reject) => {
      let settled = false;
      let runId: string | null = null;
      let eventRunId: string | null = null;
      let marker: 'database-not-found' | 'database-collision' | 'postgres-unavailable' | null =
        null;
      const timers: {
        poll?: ReturnType<typeof setInterval>;
        timeout?: ReturnType<typeof setTimeout>;
      } = {};
      const seen = new Set<string>();

      const cleanup = () => {
        if (timers.poll !== undefined) clearInterval(timers.poll);
        if (timers.timeout !== undefined) clearTimeout(timers.timeout);
        unsubscribe();
        signal.removeEventListener('abort', abort);
        activeCleanups.delete(cleanup);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const succeed = (result: RPC.GetRun) => {
        if (settled) return;
        settled = true;
        cleanup();
        onProgress({ phase: 'done', runId: runId!, message: result.run.finished_at });
        resolve(result);
      };
      const verifyTerminal = async () => {
        if (!runId || settled) return;
        try {
          const result = await caller.getRun(runId);
          const status = runStatus(result.run.status);
          if (status === STATUS_DONE) succeed(result);
          else if (status === STATUS_FAILED) {
            await catchUpMarker(runId);
            fail(new RunFailedError(runId, marker));
          }
        } catch (error) {
          fail(error);
        }
      };
      const finishResult = async (result: RPC.GetRun) => {
        if (settled) return;
        const status = runStatus(result.run.status);
        if (status === STATUS_DONE) succeed(result);
        else if (status === STATUS_FAILED) {
          await catchUpMarker(runId!);
          fail(new RunFailedError(runId!, marker));
        }
      };
      const catchUpMarker = async (id: string) => {
        if (marker) return;
        try {
          const updates = await caller.getRunUpdates({
            run_id: id,
            event_after_seq: -1,
            log_after_seq: -1,
            limit: 200,
          });
          for (const log of updates.logs.items) marker = markerFrom(log.message) ?? marker;
        } catch {
          // The terminal failure remains safe and generic when catch-up is unavailable.
        }
      };
      const bind = (id: string) => {
        if (runId && runId !== id) {
          fail(new Error('Run start identifiers did not match'));
          return false;
        }
        runId = id;
        return true;
      };
      const onEvent = (event: Events.InterfaceEvent) => {
        if (settled) return;
        if (event.eventType === 'run-start') {
          if (event.data.action !== options.action || event.data.note !== options.note) return;
          eventRunId = event.data.id;
          if (!bind(event.data.id)) return;
          onProgress({ phase: 'queued', runId: event.data.id });
          return;
        }
        if (!runId || event.data.payload.id !== runId) return;
        if (event.data.type === 'log') {
          const key = `log:${event.data.payload.seq ?? event.data.payload.message ?? 'unknown'}`;
          if (seen.has(key)) return;
          seen.add(key);
          marker = markerFrom(event.data.payload.message) ?? marker;
          return;
        }
        const payload = event.data.payload;
        const key = `event:${payload.seq ?? payload.status ?? 'unknown'}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (payload.status === STATUS_QUEUED) onProgress({ phase: 'queued', runId });
        else if (payload.status === STATUS_RUNNING)
          onProgress({ phase: 'running', runId, message: payload.message });
        else if (payload.status === STATUS_DONE) void verifyTerminal();
        else if (payload.status === STATUS_FAILED) void verifyTerminal();
      };
      const unsubscribe = source.subscribe(onEvent);
      activeCleanups.add(cleanup);
      const abort = () => fail(abortError());
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      const poll = () => {
        if (!runId || settled) return;
        void caller
          .getRun(runId)
          .then((result) => {
            const status = runStatus(result.run.status);
            if (status === STATUS_QUEUED) onProgress({ phase: 'queued', runId: runId! });
            else if (status === STATUS_RUNNING) onProgress({ phase: 'running', runId: runId! });
            else void finishResult(result);
          })
          .catch(fail);
      };
      timers.poll = setInterval(poll, POLL_MS);
      timers.timeout = setTimeout(
        () => fail(new Error('Timed out waiting for PostgreSQL operation')),
        TIMEOUT_MS,
      );
      const startedResponse = Promise.resolve().then(() => caller.start(options));
      startedResponse
        .then((response) => {
          if (!bind(response.id)) return;
          if (eventRunId && eventRunId !== response.id) return;
          if (response.status === STATUS_QUEUED)
            onProgress({ phase: 'queued', runId: response.id });
          else if (response.status === STATUS_RUNNING)
            onProgress({ phase: 'running', runId: response.id });
          else if (response.status === STATUS_DONE || response.status === STATUS_FAILED)
            void verifyTerminal();
        })
        .catch(() => {
          if (!eventRunId) fail(new Error('Unable to start PostgreSQL operation'));
        });
    });
  }

  return {
    startAndWait,
    dispose() {
      for (const cleanup of [...activeCleanups]) cleanup();
    },
  };
}
