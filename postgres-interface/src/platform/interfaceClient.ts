import {
  createWire,
  RPC,
  type Events,
  type RPCCaller,
  type RPCResponse,
  type Wire,
} from '@ezenki/deploy-commander-installer-interface';
import type { RunEventSource } from './runTracker';

export interface InterfaceClient {
  wire: Wire;
  caller: RPCCaller;
  events: RunEventSource;
  dispose(): void;
}

export function createInterfaceClient(): InterfaceClient {
  const listeners = new Set<(event: Events.InterfaceEvent) => void>();
  const events: RunEventSource = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const handleIncomingCall = async (): Promise<RPCResponse> => ({
    ok: false,
    error: { message: 'PostgreSQL manager does not accept incoming RPC requests' },
  });
  const wire = createWire(handleIncomingCall, (event) => {
    for (const listener of listeners) listener(event);
  });
  const caller = RPC.SetupRPCCaller(wire);
  let disposed = false;
  return {
    wire,
    caller,
    events,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      wire.end();
    },
  };
}
