import { describe, expect, it, vi } from 'vitest';
import type { Events, RPCCaller, RPC } from '@ezenki/deploy-commander-installer-interface';
import {
  createRunEventSource,
  RunFailedError,
  waitForRun,
  type RunEventSource,
} from './runMonitor';

function runResult(id: string, status: number): RPC.GetRun {
  return {
    run: {
      id,
      status,
      action: 'create-connection',
      created_at: '2026-08-30T00:00:00.000Z',
      queued_at: '2026-08-30T00:00:00.000Z',
      updated_at: '2026-08-30T00:00:00.000Z',
    },
    config: {
      action: 'create-connection',
      manager: 'manager-1',
      metadata: { secret: 'must-not-leak' },
      run: id,
      runner: 'runner-1',
    },
  };
}

function callerWithGetRun(getRun: RPCCaller['getRun']): RPCCaller {
  return { getRun } as unknown as RPCCaller;
}

function event(id: string | undefined, status: number | undefined): Events.InterfaceEvent {
  return {
    type: 'event',
    eventType: 'run-update',
    data: {
      type: 'event',
      payload: { id, status },
    },
  };
}

describe('run monitor', () => {
  it('publishes events to subscribers and removes them on unsubscribe', () => {
    const source = createRunEventSource();
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);

    source.publish(event('run-1', 1));
    unsubscribe();
    source.publish(event('run-1', 2));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])('continues waiting for event status %s', async (status) => {
    vi.useFakeTimers();
    try {
      const source = createRunEventSource();
      const getRun = vi.fn().mockResolvedValue(runResult('run-1', 1));
      const promise = waitForRun(callerWithGetRun(getRun), source, 'run-1', {
        pollIntervalMs: 100,
        timeoutMs: 500,
      });
      promise.catch(() => undefined);

      source.publish(event('run-1', status));
      await vi.advanceTimersByTimeAsync(100);
      expect(getRun).toHaveBeenCalledTimes(1);
      expect(await Promise.race([promise.then(() => 'resolved'), Promise.resolve('pending')])).toBe(
        'pending',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves an exact-ID successful event with its authoritative run result', async () => {
    const source = createRunEventSource();
    const result = runResult('run-1', 2);
    const getRun = vi.fn().mockResolvedValue(result);

    const promise = waitForRun(callerWithGetRun(getRun), source, 'run-1', {
      pollIntervalMs: 100,
      timeoutMs: 500,
    });
    source.publish(event('run-1', 2));

    await expect(promise).resolves.toBe(result);
    expect(getRun).toHaveBeenCalledWith('run-1');
  });

  it('rejects an exact-ID failed event with only the run ID and status', async () => {
    const source = createRunEventSource();
    const promise = waitForRun(callerWithGetRun(vi.fn()), source, 'run-1', { timeoutMs: 500 });

    source.publish(event('run-1', 3));
    await expect(promise).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(RunFailedError);
      expect(error).toMatchObject({ runId: 'run-1', status: 3 });
      expect(JSON.stringify(error)).not.toContain('must-not-leak');
      return true;
    });
  });

  it('ignores unrelated and ID-less events', async () => {
    vi.useFakeTimers();
    try {
      const source = createRunEventSource();
      const getRun = vi.fn().mockResolvedValue(runResult('run-1', 1));
      const promise = waitForRun(callerWithGetRun(getRun), source, 'run-1', {
        pollIntervalMs: 100,
        timeoutMs: 500,
      });
      promise.catch(() => undefined);

      source.publish(event('other-run', 2));
      source.publish(event(undefined, 2));
      await vi.advanceTimersByTimeAsync(100);
      expect(getRun).toHaveBeenCalledTimes(1);
      expect(await Promise.race([promise.then(() => 'resolved'), Promise.resolve('pending')])).toBe(
        'pending',
      );
      promise.catch(() => undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls getRun and resolves a missed completion', async () => {
    vi.useFakeTimers();
    try {
      const source = createRunEventSource();
      const result = runResult('run-1', 2);
      const getRun = vi.fn().mockResolvedValue(result);
      const promise = waitForRun(callerWithGetRun(getRun), source, 'run-1', {
        pollIntervalMs: 100,
        timeoutMs: 500,
      });

      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBe(result);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops on getRun rejection without mutating durable run state', async () => {
    const source = createRunEventSource();
    const failure = new Error('transport failed');
    const getRun = vi.fn().mockRejectedValue(failure);
    const promise = waitForRun(callerWithGetRun(getRun), source, 'run-1', {
      pollIntervalMs: 1,
      timeoutMs: 500,
    });
    promise.catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(promise).rejects.toBe(failure);
    source.publish(event('run-1', 2));
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it('rejects when getRun rejects with undefined', async () => {
    vi.useFakeTimers();
    try {
      const source = createRunEventSource();
      const getRun = vi.fn().mockRejectedValue(undefined);
      const promise = waitForRun(callerWithGetRun(getRun), source, 'run-1', {
        pollIntervalMs: 100,
        timeoutMs: 500,
      });
      const assertion = expect(promise).rejects.toBeUndefined();
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects unknown statuses from events and polling', async () => {
    const source = createRunEventSource();
    const eventPromise = waitForRun(callerWithGetRun(vi.fn()), source, 'run-1', { timeoutMs: 500 });
    source.publish(event('run-1', 99));
    await expect(eventPromise).rejects.toThrow('Unknown run status');

    vi.useFakeTimers();
    try {
      const pollingSource = createRunEventSource();
      const pollingPromise = waitForRun(
        callerWithGetRun(vi.fn().mockResolvedValue(runResult('run-1', 99))),
        pollingSource,
        'run-1',
        { pollIntervalMs: 100, timeoutMs: 500 },
      );
      const pollingAssertion = expect(pollingPromise).rejects.toThrow('Unknown run status');
      await vi.advanceTimersByTimeAsync(100);
      await pollingAssertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects blank or mismatched returned run IDs', async () => {
    vi.useFakeTimers();
    try {
      const source = createRunEventSource();
      const promise = waitForRun(
        callerWithGetRun(vi.fn().mockResolvedValue(runResult('  ', 2))),
        source,
        'run-1',
        { pollIntervalMs: 100, timeoutMs: 500 },
      );
      const assertion = expect(promise).rejects.toThrow('Invalid run response');
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects on timeout and abort, cleaning up its subscription', async () => {
    vi.useFakeTimers();
    try {
      const source = createRunEventSource();
      const timeoutPromise = waitForRun(
        callerWithGetRun(vi.fn().mockReturnValue(new Promise(() => undefined))),
        source,
        'run-1',
        {
          pollIntervalMs: 100,
          timeoutMs: 200,
        },
      );
      const timeoutAssertion = expect(timeoutPromise).rejects.toThrow('Timed out waiting for run');
      await vi.advanceTimersByTimeAsync(200);
      await timeoutAssertion;

      const controller = new AbortController();
      const abortPromise = waitForRun(
        callerWithGetRun(vi.fn().mockReturnValue(new Promise(() => undefined))),
        source,
        'run-1',
        {
          pollIntervalMs: 100,
          timeoutMs: 500,
          signal: controller.signal,
        },
      );
      const abortAssertion = expect(abortPromise).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await abortAssertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

export type { RunEventSource };
