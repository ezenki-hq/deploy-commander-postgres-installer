import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  CreateApprovalContext,
  CreateApprovalDecision,
} from '../workflows/createConnection';
import type {
  DeleteApprovalContext,
  DeleteApprovalDecision,
} from '../workflows/deleteConnection';
import { useDecisionController } from './useDecisionController';

const createContext: CreateApprovalContext = {
  callingManagerId: 'consumer-1',
  requestedAccess: { scope: 'database', operation: 'create', database: 'orders' },
  callerLabels: {},
  databaseNames: ['orders'],
};
const createAccess = { scope: 'database', operation: 'create', database: 'orders' } as const;
const deleteContext: DeleteApprovalContext = {
  callingManagerId: 'consumer-1',
  requestedConnectionId: 'connection-1',
  choices: [],
};

describe('useDecisionController', () => {
  it('exposes a create decision and resolves only from decide', async () => {
    const { result, unmount } = renderHook(() => useDecisionController());
    let pending!: Promise<CreateApprovalDecision>;
    act(() => {
      pending = result.current.requestCreate(createContext);
    });
    expect(result.current.pending).toEqual({ kind: 'create', context: createContext });
    act(() => result.current.decideCreate({ allowed: true, access: createAccess }));
    await expect(pending).resolves.toEqual({ allowed: true, access: createAccess });
    unmount();
  });

  it('resolves a pending decision as rejected on unmount', async () => {
    const { result, unmount } = renderHook(() => useDecisionController());
    let pending!: Promise<DeleteApprovalDecision>;
    act(() => {
      pending = result.current.requestDelete(deleteContext);
    });
    unmount();
    await expect(pending).resolves.toEqual({ allowed: false });
  });

  it('never keeps two pending decisions', async () => {
    const { result, unmount } = renderHook(() => useDecisionController());
    let first!: Promise<CreateApprovalDecision>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.requestCreate(createContext);
    });
    act(() => {
      second = result.current.requestTeardown();
    });
    await expect(first).resolves.toEqual({ allowed: false });
    expect(result.current.pending?.kind).toBe('teardown');
    act(() => result.current.decideTeardown(false));
    await expect(second).resolves.toBe(false);
    unmount();
  });
});
