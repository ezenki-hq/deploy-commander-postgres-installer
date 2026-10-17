import {
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_QUEUED,
  STATUS_RUNNING,
  type Events,
  type RPC,
} from '@ezenki/deploy-commander-installer-interface';
import { expect, it, vi } from 'vitest';
import { deferred, fakeCaller, testEventSource } from '../test/fakes';
import { createRunTracker, type RunProgress } from './runTracker';

const events = testEventSource();

const startOptions = (note: string) => ({
  action: 'create-connection',
  runner: 'ezenki/deploy-commander-runner:latest',
  note,
});

const run = (id: string, status: number): RPC.GetRun => ({
  run: {
    id,
    action: 'create-connection',
    status,
    queued_at: '2026-09-20T00:00:00Z',
    created_at: '2026-09-20T00:00:00Z',
    updated_at: '2026-09-20T00:00:00Z',
  },
  config: {
    action: 'create-connection',
    manager: 'postgres-manager',
    metadata: {},
    run: id,
    runner: 'ezenki/deploy-commander-runner:latest',
  },
});

const doneRun = (id: string) => run(id, STATUS_DONE);
const runningRun = (id: string) => run(id, STATUS_RUNNING);
const failedRun = (id: string) => run(id, STATUS_FAILED);

const runStartEvent = (data: {
  id: string;
  action: string;
  note: string;
}): Events.InterfaceEvent => ({
  type: 'event',
  eventType: 'run-start',
  data: { ...data, manager: 'postgres-manager' },
});

const runUpdateEvent = (data: {
  id: string;
  status: number;
  seq?: number;
  phase?: string;
  message?: string;
}): Events.InterfaceEvent => ({
  type: 'event',
  eventType: 'run-update',
  data: {
    type: 'event',
    payload: { ...data, run_id: data.id, phase: data.phase ?? 'run' },
  },
});

const runLogEvent = (data: {
  id: string;
  seq: number;
  message: string;
}): Events.InterfaceEvent => ({
  type: 'event',
  eventType: 'run-update',
  data: { type: 'log', payload: { ...data, run_id: data.id, stream: 'stderr', level: 'error' } },
});

it('reports starting before start and binds a run-start event that arrives first', async () => {
  const progress: RunProgress[] = [];
  const started = deferred<{ id: string; queued_at: string; status: number }>();
  const caller = fakeCaller({
    start: vi.fn(() => started.promise),
    getRun: vi.fn().mockResolvedValue(doneRun('run-1')),
  });
  const tracker = createRunTracker(caller, events);
  const waiting = tracker.startAndWait(
    startOptions('note-1'),
    (value) => progress.push(value),
    new AbortController().signal,
  );
  expect(progress[0]).toEqual({ phase: 'starting', runId: null });
  events.publish(runStartEvent({ id: 'run-1', action: 'create-connection', note: 'note-1' }));
  started.resolve({ id: 'run-1', queued_at: '2026-09-20T00:00:00Z', status: STATUS_QUEUED });
  events.publish(runUpdateEvent({ id: 'run-1', status: STATUS_DONE }));
  await expect(waiting).resolves.toEqual(doneRun('run-1'));
  tracker.dispose();
});

it('ignores unrelated and duplicate events', async () => {
  const progress: RunProgress[] = [];
  const caller = fakeCaller({
    start: vi
      .fn()
      .mockResolvedValue({ id: 'run-1', queued_at: '2026-09-20T00:00:00Z', status: STATUS_QUEUED }),
    getRun: vi.fn().mockResolvedValue(doneRun('run-1')),
  });
  const tracker = createRunTracker(caller, events);
  const waiting = tracker.startAndWait(
    startOptions('note-1'),
    (value) => progress.push(value),
    new AbortController().signal,
  );
  events.publish(runStartEvent({ id: 'run-1', action: 'create-connection', note: 'note-1' }));
  events.publish(runUpdateEvent({ id: 'run-2', status: STATUS_RUNNING }));
  events.publish(runUpdateEvent({ id: 'run-1', status: STATUS_RUNNING, seq: 4 }));
  events.publish(runUpdateEvent({ id: 'run-1', status: STATUS_RUNNING, seq: 4 }));
  events.publish(runUpdateEvent({ id: 'run-1', status: STATUS_DONE, seq: 5 }));
  await waiting;
  expect(progress.map((value) => value.phase)).toEqual(['starting', 'queued', 'running', 'done']);
  expect(progress.some((value) => value.runId === 'run-2')).toBe(false);
  tracker.dispose();
});

it('fails when run-start and start response IDs disagree', async () => {
  const started = deferred<{ id: string; queued_at: string; status: number }>();
  const caller = fakeCaller({ start: vi.fn(() => started.promise) });
  const tracker = createRunTracker(caller, events);
  const waiting = tracker.startAndWait(
    startOptions('note-1'),
    vi.fn(),
    new AbortController().signal,
  );
  events.publish(
    runStartEvent({ id: 'run-from-event', action: 'create-connection', note: 'note-1' }),
  );
  started.resolve({
    id: 'run-from-response',
    queued_at: '2026-09-20T00:00:00Z',
    status: STATUS_QUEUED,
  });
  await expect(waiting).rejects.toThrow('Run start identifiers did not match');
  tracker.dispose();
});

it('shows the latest structured event and checks status every five minutes without ending an active run', async () => {
  vi.useFakeTimers();
  const progress: RunProgress[] = [];
  const runEvents = testEventSource();
  const caller = fakeCaller({
    start: vi
      .fn()
      .mockResolvedValue({ id: 'run-1', queued_at: '2026-09-20T00:00:00Z', status: STATUS_QUEUED }),
    getRun: vi
      .fn()
      .mockResolvedValueOnce(runningRun('run-1'))
      .mockResolvedValueOnce(runningRun('run-1'))
      .mockResolvedValueOnce(doneRun('run-1')),
  });
  const tracker = createRunTracker(caller, runEvents);
  let completed = false;
  const waiting = tracker
    .startAndWait(
      startOptions('note-1'),
      (value) => progress.push(value),
      new AbortController().signal,
    )
    .then((result) => {
      completed = true;
      return result;
    });
  runEvents.publish(runStartEvent({ id: 'run-1', action: 'create-connection', note: 'note-1' }));
  runEvents.publish(
    runUpdateEvent({
      id: 'run-1',
      status: STATUS_RUNNING,
      seq: 1,
      phase: 'provision',
      message: 'Creating PostgreSQL service',
    }),
  );
  expect(progress[progress.length - 1]).toMatchObject({
    phase: 'running',
    runId: 'run-1',
    lastEvent: { phase: 'provision', message: 'Creating PostgreSQL service' },
  });
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
  expect(caller.getRun).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(caller.getRun).toHaveBeenCalledTimes(1);
  expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(caller.getRun).toHaveBeenCalledTimes(2);
  expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  await Promise.resolve();
  await Promise.resolve();
  expect(caller.getRun).toHaveBeenCalledTimes(3);
  expect(progress[progress.length - 1]).toMatchObject({ phase: 'done', runId: 'run-1' });
  expect(completed).toBe(true);
  await expect(waiting).resolves.toEqual(doneRun('run-1'));
  expect(caller.getRun).toHaveBeenCalledWith('run-1');
  tracker.dispose();
  vi.useRealTimers();
});

it('applies run updates received before the start response identifies the run', async () => {
  const progress: RunProgress[] = [];
  const runEvents = testEventSource();
  const started = deferred<{ id: string; queued_at: string; status: number }>();
  const caller = fakeCaller({ start: vi.fn(() => started.promise) });
  const tracker = createRunTracker(caller, runEvents);
  const controller = new AbortController();
  const waiting = tracker.startAndWait(
    startOptions('note-1'),
    (value) => progress.push(value),
    controller.signal,
  );
  runEvents.publish(
    runUpdateEvent({
      id: 'run-1',
      status: STATUS_RUNNING,
      seq: 1,
      phase: 'provision',
      message: 'Creating PostgreSQL service',
    }),
  );
  started.resolve({ id: 'run-1', queued_at: '2026-09-20T00:00:00Z', status: STATUS_RUNNING });
  await started.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(progress[progress.length - 1]).toMatchObject({
    phase: 'running',
    runId: 'run-1',
    lastEvent: { phase: 'provision', message: 'Creating PostgreSQL service' },
  });
  controller.abort();
  tracker.dispose();
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
});

it('keeps an older out-of-order event from replacing the latest event', async () => {
  const progress: RunProgress[] = [];
  const runEvents = testEventSource();
  const caller = fakeCaller({
    start: vi.fn().mockResolvedValue({
      id: 'run-1',
      queued_at: '2026-09-20T00:00:00Z',
      status: STATUS_RUNNING,
    }),
  });
  const controller = new AbortController();
  const tracker = createRunTracker(caller, runEvents);
  const waiting = tracker.startAndWait(
    startOptions('note-1'),
    (value) => progress.push(value),
    controller.signal,
  );
  runEvents.publish(runStartEvent({ id: 'run-1', action: 'create-connection', note: 'note-1' }));
  runEvents.publish(
    runUpdateEvent({
      id: 'run-1',
      status: STATUS_RUNNING,
      seq: 2,
      phase: 'provision',
      message: 'Latest event',
    }),
  );
  runEvents.publish(
    runUpdateEvent({
      id: 'run-1',
      status: STATUS_RUNNING,
      seq: 1,
      phase: 'prepare',
      message: 'Older event',
    }),
  );
  expect(progress[progress.length - 1]).toMatchObject({
    lastEvent: { phase: 'provision', message: 'Latest event' },
  });
  controller.abort();
  tracker.dispose();
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
});

it('continues from a matching run-start when the start response is lost', async () => {
  const started = deferred<{ id: string; queued_at: string; status: number }>();
  const caller = fakeCaller({
    start: vi.fn(() => started.promise),
    getRun: vi.fn().mockResolvedValue(doneRun('run-1')),
  });
  const tracker = createRunTracker(caller, events);
  const waiting = tracker.startAndWait(
    startOptions('note-1'),
    vi.fn(),
    new AbortController().signal,
  );
  events.publish(runStartEvent({ id: 'run-1', action: 'create-connection', note: 'note-1' }));
  started.reject(new Error('transport lost'));
  events.publish(runUpdateEvent({ id: 'run-1', status: STATUS_DONE, seq: 5 }));
  await expect(waiting).resolves.toEqual(doneRun('run-1'));
  tracker.dispose();
});

it('does not search history when start fails without a matching run-start', async () => {
  const caller = fakeCaller({ start: vi.fn().mockRejectedValue(new Error('offline')) });
  const tracker = createRunTracker(caller, events);
  await expect(
    tracker.startAndWait(startOptions('note-1'), vi.fn(), new AbortController().signal),
  ).rejects.toThrow('Unable to start PostgreSQL operation');
  expect(caller.getRun).not.toHaveBeenCalled();
  tracker.dispose();
});

it('returns only a typed safe marker from a failed run log', async () => {
  const caller = fakeCaller({
    start: vi
      .fn()
      .mockResolvedValue({ id: 'run-1', queued_at: '2026-09-20T00:00:00Z', status: STATUS_QUEUED }),
    getRun: vi.fn().mockResolvedValue(failedRun('run-1')),
  });
  const tracker = createRunTracker(caller, events);
  const waiting = tracker.startAndWait(
    startOptions('note-1'),
    vi.fn(),
    new AbortController().signal,
  );
  events.publish(runStartEvent({ id: 'run-1', action: 'create-connection', note: 'note-1' }));
  events.publish(
    runLogEvent({
      id: 'run-1',
      seq: 3,
      message: 'POSTGRES_MANAGER_ERROR: database-collision password=must-not-escape',
    }),
  );
  events.publish(runUpdateEvent({ id: 'run-1', status: STATUS_FAILED, seq: 4 }));
  await expect(waiting).rejects.toMatchObject({
    runId: 'run-1',
    marker: 'database-collision',
    message: 'PostgreSQL operation failed',
  });
  tracker.dispose();
});

it('recognizes postgres-unavailable without exposing runner log text', async () => {
  const caller = fakeCaller({
    start: vi
      .fn()
      .mockResolvedValue({ id: 'run-1', queued_at: '2026-09-20T00:00:00Z', status: STATUS_QUEUED }),
    getRun: vi.fn().mockResolvedValue(failedRun('run-1')),
  });
  const tracker = createRunTracker(caller, events);
  const waiting = tracker.startAndWait(
    startOptions('note-1'),
    vi.fn(),
    new AbortController().signal,
  );
  events.publish(runStartEvent({ id: 'run-1', action: 'create-connection', note: 'note-1' }));
  events.publish(
    runLogEvent({
      id: 'run-1',
      seq: 3,
      message: 'POSTGRES_MANAGER_ERROR: postgres-unavailable',
    }),
  );
  events.publish(runUpdateEvent({ id: 'run-1', status: STATUS_FAILED, seq: 4 }));
  await expect(waiting).rejects.toMatchObject({
    runId: 'run-1',
    marker: 'postgres-unavailable',
    message: 'PostgreSQL operation failed',
  });
  tracker.dispose();
});
