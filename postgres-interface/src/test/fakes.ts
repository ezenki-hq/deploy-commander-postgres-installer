import type { Events, RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import { vi } from 'vitest';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function fakeCaller(overrides: Record<string, unknown> = {}) {
  return {
    getMyResources: vi.fn(),
    getResource: vi.fn(),
    getConnections: vi.fn(),
    getConnection: vi.fn(),
    start: vi.fn(),
    getRun: vi.fn(),
    getRunUpdates: vi.fn(),
    ...overrides,
  } as unknown as RPCCaller;
}

export function testEventSource() {
  const listeners = new Set<(event: Events.InterfaceEvent) => void>();
  return {
    subscribe(listener: (event: Events.InterfaceEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(event: Events.InterfaceEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}
