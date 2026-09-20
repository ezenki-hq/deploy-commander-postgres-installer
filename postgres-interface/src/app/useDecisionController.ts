import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreateApprovalContext, CreateApprovalDecision } from '../workflows/createConnection';
import type { DeleteApprovalContext, DeleteApprovalDecision } from '../workflows/deleteConnection';

export type PendingDecision =
  | { kind: 'create'; context: CreateApprovalContext }
  | { kind: 'delete'; context: DeleteApprovalContext }
  | { kind: 'teardown' };

type DecisionValue = CreateApprovalDecision | DeleteApprovalDecision | boolean;

type ActiveResolver =
  | {
      kind: 'create';
      resolve: (decision: CreateApprovalDecision) => void;
    }
  | {
      kind: 'delete';
      resolve: (decision: DeleteApprovalDecision) => void;
    }
  | {
      kind: 'teardown';
      resolve: (confirmed: boolean) => void;
    };

export interface DecisionController {
  pending: PendingDecision | null;
  requestCreate(context: CreateApprovalContext): Promise<CreateApprovalDecision>;
  requestDelete(context: DeleteApprovalContext): Promise<DeleteApprovalDecision>;
  requestTeardown(): Promise<boolean>;
  decideCreate(decision: CreateApprovalDecision): void;
  decideDelete(decision: DeleteApprovalDecision): void;
  decideTeardown(confirmed: boolean): void;
}

function rejectedValue(kind: ActiveResolver['kind']): DecisionValue {
  return kind === 'teardown' ? false : { allowed: false };
}

export function useDecisionController(): DecisionController {
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const active = useRef<ActiveResolver | null>(null);

  const replace = useCallback(
    <T extends ActiveResolver>(next: PendingDecision, resolver: T): void => {
      if (active.current) active.current.resolve(rejectedValue(active.current.kind) as never);
      active.current = resolver;
      setPending(next);
    },
    [],
  );

  const requestCreate = useCallback(
    (context: CreateApprovalContext) =>
      new Promise<CreateApprovalDecision>((resolve) => {
        replace({ kind: 'create', context }, { kind: 'create', resolve });
      }),
    [replace],
  );
  const requestDelete = useCallback(
    (context: DeleteApprovalContext) =>
      new Promise<DeleteApprovalDecision>((resolve) => {
        replace({ kind: 'delete', context }, { kind: 'delete', resolve });
      }),
    [replace],
  );
  const requestTeardown = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        replace({ kind: 'teardown' }, { kind: 'teardown', resolve });
      }),
    [replace],
  );

  const decide = useCallback((value: DecisionValue, kind: ActiveResolver['kind']) => {
    if (!active.current || active.current.kind !== kind) return;
    const resolver = active.current;
    active.current = null;
    setPending(null);
    resolver.resolve(value as never);
  }, []);

  const decideCreate = useCallback(
    (decision: CreateApprovalDecision) => decide(decision, 'create'),
    [decide],
  );
  const decideDelete = useCallback(
    (decision: DeleteApprovalDecision) => decide(decision, 'delete'),
    [decide],
  );
  const decideTeardown = useCallback(
    (confirmed: boolean) => decide(confirmed, 'teardown'),
    [decide],
  );

  useEffect(
    () => () => {
      if (active.current) active.current.resolve(rejectedValue(active.current.kind) as never);
      active.current = null;
    },
    [],
  );

  return {
    pending,
    requestCreate,
    requestDelete,
    requestTeardown,
    decideCreate,
    decideDelete,
    decideTeardown,
  };
}
