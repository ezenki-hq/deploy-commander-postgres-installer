export interface ActionGateFailure {
  status: number;
  message: string;
  retryable: boolean;
}

export type ActionGateState<Context> =
  | { kind: 'preparing'; callerId: string | null }
  | { kind: 'ready'; callerId: string; context: Context }
  | { kind: 'blocked'; callerId: string | null; failure: ActionGateFailure }
  | { kind: 'executing'; callerId: string; context: Context }
  | { kind: 'closed' };

export type ActionGateEvent<Context> =
  | { type: 'identified'; callerId: string }
  | { type: 'prepared'; callerId: string; context: Context }
  | { type: 'blocked'; failure: ActionGateFailure }
  | { type: 'approve' }
  | { type: 'retry' }
  | { type: 'close' }
  | { type: 'complete' };

export function initialActionGate<Context>(
  failure?: ActionGateFailure | null,
): ActionGateState<Context> {
  if (failure) return { kind: 'blocked', callerId: null, failure };
  return { kind: 'preparing', callerId: null };
}

export function actionGateReducer<Context>(
  state: ActionGateState<Context>,
  event: ActionGateEvent<Context>,
): ActionGateState<Context> {
  if (state.kind === 'closed') return state;
  if (event.type === 'complete' && state.kind === 'executing') return { kind: 'closed' };
  if (event.type === 'close' && state.kind !== 'executing') return { kind: 'closed' };
  if (event.type === 'identified' && state.kind === 'preparing')
    return { kind: 'preparing', callerId: event.callerId };
  if (event.type === 'prepared' && state.kind === 'preparing' && state.callerId === event.callerId)
    return { kind: 'ready', callerId: event.callerId, context: event.context };
  if (event.type === 'blocked' && state.kind !== 'executing')
    return {
      kind: 'blocked',
      callerId: state.callerId,
      failure: event.failure,
    };
  if (event.type === 'approve' && state.kind === 'ready')
    return { kind: 'executing', callerId: state.callerId, context: state.context };
  if (event.type === 'retry' && state.kind === 'blocked' && state.failure.retryable)
    return { kind: 'preparing', callerId: null };
  return state;
}
