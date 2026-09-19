import {
  createWire,
  RPC,
  type Events,
  type RPCCaller,
  type RPCResponse,
  type Wire,
  type WireSend,
} from '@ezenki/deploy-commander-installer-interface';
import type { RunEventSource } from './runMonitor';

export interface InterfaceClient {
  wire: Wire;
  caller: RPCCaller;
}

export interface AppClient extends InterfaceClient {
  events: RunEventSource;
}

export function createInterfaceClient(
  onEvent: (event: Events.InterfaceEvent) => void = () => undefined,
): InterfaceClient {
  const handleIncomingRequest = async (request: WireSend): Promise<RPCResponse> => ({
    ok: false,
    error: {
      message: `Unsupported request: ${request.request}`,
    },
  });

  const wire = createWire(handleIncomingRequest, onEvent);
  const caller = RPC.SetupRPCCaller(wire);
  return { wire, caller };
}
