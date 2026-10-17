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
  | {
      phase: 'queued' | 'running' | 'done' | 'failed';
      runId: string;
      lastEvent?: { phase?: string; message?: string };
    };

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

const STATUS_CHECK_MS = 300_000;

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
      let phase: 'queued' | 'running' | 'failed' = 'queued';
      let lastEvent: { phase?: string; message?: string } | undefined;
      let statusCheckInFlight = false;
      let checkAgainImmediately = false;
      let latestEventSequence: number | undefined;
      let pendingUpdates: Events.RunUpdateData[] = [];
      let unsubscribe: () => void = () => {};
      const timers: { statusCheck?: ReturnType<typeof setTimeout> } = {};
      const seen = new Set<string>();

      const cleanup = () => {
        if (timers.statusCheck !== undefined) clearTimeout(timers.statusCheck);
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
        onProgress({ phase: 'done', runId: runId!, lastEvent });
        resolve(result);
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
          // Keep failures generic if run logs are unavailable.
        }
      };
      const finishResult = async (result: RPC.GetRun) => {
        if (settled) return;
        const status = runStatus(result.run.status);
        if (status === STATUS_DONE) succeed(result);
        else if (status === STATUS_FAILED) {
          phase = 'failed';
          emitProgress();
          await catchUpMarker(runId!);
          fail(new RunFailedError(runId!, marker));
        } else {
          const nextPhase = status === STATUS_RUNNING ? 'running' : phase;
          if (phase !== nextPhase) {
            phase = nextPhase;
            emitProgress();
          }
        }
      };
      const emitProgress = () => {
        if (runId) onProgress({ phase, runId, lastEvent });
      };
      const scheduleStatusCheck = (delay = STATUS_CHECK_MS) => {
        if (settled) return;
        if (timers.statusCheck !== undefined) clearTimeout(timers.statusCheck);
        timers.statusCheck = setTimeout(() => void checkStatus(), delay);
      };
      const checkStatus = async () => {
        if (settled) return;
        if (statusCheckInFlight) {
          checkAgainImmediately = true;
          return;
        }
        if (!runId) {
          scheduleStatusCheck();
          return;
        }
        statusCheckInFlight = true;
        try {
          await finishResult(await caller.getRun(runId));
        } catch {
          // A status check failure does not end a run that may still be active.
        } finally {
          statusCheckInFlight = false;
          if (!settled) {
            const delay = checkAgainImmediately ? 0 : STATUS_CHECK_MS;
            checkAgainImmediately = false;
            scheduleStatusCheck(delay);
          }
        }
      };
      const processUpdate = (update: Events.RunUpdateData) => {
        if (settled || !runId || update.payload.run_id !== runId) return;
        if (update.type === 'log') {
          const payload = update.payload;
          const key = `log:${payload.seq ?? payload.message ?? 'unknown'}`;
          if (seen.has(key)) return;
          seen.add(key);
          marker = markerFrom(payload.message) ?? marker;
          return;
        }

        const payload = update.payload;
        const key = `event:${payload.seq ?? `${payload.status}:${payload.phase}:${payload.message}`}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (typeof payload.seq === 'number') {
          if (latestEventSequence !== undefined && payload.seq < latestEventSequence) {
            if (payload.status === STATUS_DONE || payload.status === STATUS_FAILED)
              void checkStatus();
            return;
          }
          latestEventSequence = payload.seq;
        }
        if (phase === 'failed') return;
        const previousPhase = phase;
        const previousEvent = lastEvent;
        if (payload.phase || payload.message) {
          lastEvent = {
            ...(payload.phase ? { phase: payload.phase } : {}),
            ...(payload.message ? { message: payload.message } : {}),
          };
        }
        if (payload.status === STATUS_QUEUED && phase !== 'running') phase = 'queued';
        else if (payload.status === STATUS_RUNNING) phase = 'running';
        if (
          phase !== previousPhase ||
          lastEvent?.phase !== previousEvent?.phase ||
          lastEvent?.message !== previousEvent?.message
        )
          emitProgress();
        if (payload.status === STATUS_DONE || payload.status === STATUS_FAILED) void checkStatus();
      };
      const receiveUpdate = (update: Events.RunUpdateData) => {
        if (runId) {
          processUpdate(update);
          return;
        }
        pendingUpdates.push(update);
        if (pendingUpdates.length > 100) pendingUpdates = pendingUpdates.slice(-100);
      };
      const bind = (id: string) => {
        if (runId && runId !== id) {
          fail(new Error('Run start identifiers did not match'));
          return false;
        }
        runId = id;
        scheduleStatusCheck();
        const updates = pendingUpdates;
        pendingUpdates = [];
        for (const update of updates) processUpdate(update);
        return true;
      };
      const onEvent = (event: Events.InterfaceEvent) => {
        if (settled) return;
        if (event.eventType === 'run-start') {
          if (event.data.action !== options.action || event.data.note !== options.note) return;
          if (eventRunId === event.data.id) return;
          eventRunId = event.data.id;
          if (!bind(event.data.id)) return;
          if (phase !== 'running') phase = 'queued';
          emitProgress();
          return;
        }
        receiveUpdate(event.data);
      };
      unsubscribe = source.subscribe(onEvent);
      activeCleanups.add(cleanup);
      const abort = () => fail(abortError());
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      const startedResponse = Promise.resolve().then(() => caller.start(options));
      startedResponse
        .then((response) => {
          if (settled) return;
          const runWasKnown = runId !== null;
          const hadPendingUpdates = pendingUpdates.length > 0;
          if (!bind(response.id)) return;
          if (eventRunId && eventRunId !== response.id) return;
          const previousPhase = phase;
          if (response.status === STATUS_QUEUED && phase !== 'running') phase = 'queued';
          else if (response.status === STATUS_RUNNING) phase = 'running';
          if (phase !== previousPhase || (!runWasKnown && !eventRunId && !hadPendingUpdates))
            emitProgress();
          if (response.status === STATUS_DONE || response.status === STATUS_FAILED)
            void checkStatus();
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
