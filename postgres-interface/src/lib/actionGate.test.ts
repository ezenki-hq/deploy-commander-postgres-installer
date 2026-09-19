import { describe, expect, it } from 'vitest';
import { actionGateReducer, initialActionGate } from './actionGate';

type Context = { callingManagerId: string; operation: 'create' };
const context: Context = { callingManagerId: 'consumer-manager', operation: 'create' };

describe('actionGateReducer', () => {
  it('starts valid requests visibly while caller lookup is pending', () => {
    const preparing = initialActionGate<Context>();
    expect(preparing).toEqual({ kind: 'preparing', callerId: null });
    expect(actionGateReducer(preparing, { type: 'approve' })).toBe(preparing);
    expect(
      actionGateReducer(preparing, { type: 'identified', callerId: 'consumer-manager' }),
    ).toEqual({ kind: 'preparing', callerId: 'consumer-manager' });
  });

  it('accepts prepared context only with an authoritative caller', () => {
    const preparing = actionGateReducer(initialActionGate<Context>(), {
      type: 'identified',
      callerId: 'consumer-manager',
    });
    expect(
      actionGateReducer(preparing, {
        type: 'prepared',
        callerId: 'different-manager',
        context,
      }),
    ).toBe(preparing);
    expect(
      actionGateReducer(preparing, {
        type: 'prepared',
        callerId: 'consumer-manager',
        context,
      }),
    ).toEqual({
      kind: 'ready',
      callerId: 'consumer-manager',
      context,
    });
  });

  it('starts parsing failures as blocked visible requests', () => {
    expect(
      initialActionGate<Context>({
        status: 400,
        message: 'Invalid PostgreSQL connection request',
        retryable: false,
      }),
    ).toEqual({
      kind: 'blocked',
      callerId: null,
      failure: {
        status: 400,
        message: 'Invalid PostgreSQL connection request',
        retryable: false,
      },
    });
  });

  it('permits exactly one ready-to-executing transition', () => {
    const ready = { kind: 'ready' as const, callerId: 'consumer-manager', context };
    const executing = actionGateReducer(ready, { type: 'approve' });
    expect(executing).toEqual({ kind: 'executing', callerId: 'consumer-manager', context });
    expect(actionGateReducer(executing, { type: 'approve' })).toBe(executing);
    expect(actionGateReducer(executing, { type: 'close' })).toBe(executing);
    expect(actionGateReducer(executing, { type: 'complete' })).toEqual({ kind: 'closed' });
  });

  it('represents a missing caller as a blocked visible request', () => {
    expect(
      actionGateReducer(initialActionGate<Context>(), {
        type: 'blocked',
        failure: { status: 400, message: 'A calling manager is required', retryable: false },
      }),
    ).toEqual({
      kind: 'blocked',
      callerId: null,
      failure: { status: 400, message: 'A calling manager is required', retryable: false },
    });
  });

  it('can invalidate ready context without losing caller identity', () => {
    const ready = { kind: 'ready' as const, callerId: 'consumer-manager', context };
    expect(
      actionGateReducer(ready, {
        type: 'blocked',
        failure: { status: 409, message: 'PostgreSQL state changed', retryable: true },
      }),
    ).toEqual({
      kind: 'blocked',
      callerId: 'consumer-manager',
      failure: { status: 409, message: 'PostgreSQL state changed', retryable: true },
    });
  });

  it('keeps blocked requests visible until retry or close', () => {
    const identified = actionGateReducer(initialActionGate<Context>(), {
      type: 'identified',
      callerId: 'consumer-manager',
    });
    const blocked = actionGateReducer(identified, {
      type: 'blocked',
      failure: { status: 503, message: 'PostgreSQL recovery is required', retryable: true },
    });
    expect(actionGateReducer(blocked, { type: 'retry' })).toEqual({
      kind: 'preparing',
      callerId: null,
    });
    expect(actionGateReducer(blocked, { type: 'close' })).toEqual({ kind: 'closed' });
  });

  it('never reopens a closed request', () => {
    const closed = { kind: 'closed' as const };
    expect(
      actionGateReducer(closed, {
        type: 'prepared',
        callerId: 'consumer-manager',
        context,
      }),
    ).toBe(closed);
    expect(actionGateReducer(closed, { type: 'retry' })).toBe(closed);
  });
});
