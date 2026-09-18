import type { Events, RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';

const STATUS_QUEUED = 0;
const STATUS_RUNNING = 1;
const STATUS_DONE = 2;
const STATUS_FAILED = 3;

export type RunEventListener = (event: Events.InterfaceEvent) => void;

export interface RunEventSource {
  subscribe(listener: RunEventListener): () => void;
  publish(event: Events.InterfaceEvent): void;
}

export function createRunEventSource(): RunEventSource {
  const listeners = new Set<RunEventListener>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(event) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

export class RunFailedError extends Error {
  readonly runId: string;
  readonly status: number;

  constructor(runId: string, status: number) {
    super(`Run ${runId} failed with status ${status}`);
    this.name = 'RunFailedError';
    this.runId = runId;
    this.status = status;
  }
}

export interface WaitOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 300_000;

function abortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Run wait aborted', 'AbortError');
  }
  const error = new Error('Run wait aborted');
  error.name = 'AbortError';
  return error;
}

function invalidRunResponse(): Error {
  return new Error('Invalid run response');
}

function unknownRunStatus(): Error {
  return new Error('Unknown run status');
}

function readRunStatus(result: RPC.GetRun, expectedRunId: string): number {
  if (
    typeof result !== 'object' ||
    result === null ||
    typeof result.run !== 'object' ||
    result.run === null ||
    typeof result.run.id !== 'string' ||
    result.run.id.trim().length === 0 ||
    result.run.id !== expectedRunId
  ) {
    throw invalidRunResponse();
  }

  const status = result.run.status;
  if (
    status !== STATUS_QUEUED &&
    status !== STATUS_RUNNING &&
    status !== STATUS_DONE &&
    status !== STATUS_FAILED
  ) {
    throw unknownRunStatus();
  }
  return status;
}

function normalizeWaitOptions(options: WaitOptions): { pollIntervalMs: number; timeoutMs: number } {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  ) {
    throw new Error('Invalid run wait options');
  }
  return { pollIntervalMs, timeoutMs };
}

export function waitForRun(
  caller: RPCCaller,
  source: RunEventSource,
  runId: string,
  options: WaitOptions = {},
): Promise<RPC.GetRun> {
  let normalized: { pollIntervalMs: number; timeoutMs: number };
  try {
    normalized = normalizeWaitOptions(options);
  } catch (error) {
    return Promise.reject(error);
  }

  if (typeof runId !== 'string' || runId.trim().length === 0) {
    return Promise.reject(invalidRunResponse());
  }

  return new Promise<RPC.GetRun>((resolve, reject) => {
    let settled = false;
    let polling = false;

    const cleanup = () => {
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      unsubscribe();
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    };

    const succeed = (result: RPC.GetRun) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const inspectResult = (result: RPC.GetRun) => {
      if (settled) return;
      try {
        const status = readRunStatus(result, runId);
        if (status === STATUS_DONE) {
          succeed(result);
        } else if (status === STATUS_FAILED) {
          fail(new RunFailedError(runId, STATUS_FAILED));
        }
      } catch (error) {
        fail(error);
      }
    };

    const poll = () => {
      if (settled || polling) return;
      polling = true;
      Promise.resolve()
        .then(() => caller.getRun(runId))
        .then((result) => {
          polling = false;
          inspectResult(result);
        })
        .catch((error: unknown) => {
          polling = false;
          fail(error);
        });
    };

    const onEvent = (event: Events.InterfaceEvent) => {
      if (settled || event.eventType !== 'run-update' || event.data.type !== 'event') return;
      const { id, status } = event.data.payload;
      if (id !== runId || status === undefined) return;
      if (status === STATUS_QUEUED || status === STATUS_RUNNING) return;
      if (status === STATUS_FAILED) {
        fail(new RunFailedError(runId, STATUS_FAILED));
      } else if (status === STATUS_DONE) {
        poll();
      } else {
        fail(unknownRunStatus());
      }
    };

    function onAbort() {
      fail(abortError());
    }

    const pollTimer = setInterval(poll, normalized.pollIntervalMs);
    const timeoutTimer = setTimeout(() => {
      fail(new Error('Timed out waiting for run'));
    }, normalized.timeoutMs);
    const unsubscribe = source.subscribe(onEvent);
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}
