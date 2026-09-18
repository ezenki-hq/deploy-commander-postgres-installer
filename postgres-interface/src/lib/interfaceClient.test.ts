import { describe, expect, it, vi } from 'vitest';
import type { Events } from '@ezenki/deploy-commander-installer-interface';
import { createInterfaceClient } from './interfaceClient';

describe('interface client', () => {
  it('returns one stable wire/caller pair and forwards events', () => {
    const onEvent = vi.fn();
    const client = createInterfaceClient(onEvent);

    expect(client.wire).toBeDefined();
    expect(client.caller).toBeDefined();
    expect(client.caller.getRun).toBeTypeOf('function');

    const event: Events.InterfaceEvent = {
      type: 'event',
      eventType: 'run-start',
      data: { id: 'run-1', manager: 'manager-1', action: 'test' },
    };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: event,
        source: window.parent,
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(event);

    client.wire.end();
  });

  it('retains the raw wire for close and end while exposing the caller', () => {
    const client = createInterfaceClient(vi.fn());
    const close = client.wire.close;
    const end = client.wire.end;

    expect(close).toBeTypeOf('function');
    expect(end).toBeTypeOf('function');
    expect(client.wire).toHaveProperty('sendRPC');
    expect(client.caller).toHaveProperty('getRuns');

    end.call(client.wire);
  });

  it('returns a structured unsupported-request response without logging payloads', async () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const client = createInterfaceClient(vi.fn());
    const postMessage = vi.spyOn(window.parent, 'postMessage');

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'rpc.send',
          wireId: 'wire-1',
          request: 'privateRequest',
          payload: { secret: 'must-not-log' },
        },
        source: window.parent,
      }),
    );
    await Promise.resolve();

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'rpc.send-res',
        wireId: 'wire-1',
        from: undefined,
        to: undefined,
        ok: false,
        error: { message: 'Unsupported request: privateRequest' },
      },
      '*',
    );
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('must-not-log'));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('must-not-log'));
    client.wire.end();
  });
});
