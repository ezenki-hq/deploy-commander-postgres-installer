# PostgreSQL Action Approval Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that every PostgreSQL state-changing action has a visible, one-shot user-approval gate, including requests with missing caller identity or failed preparation, and prove that the tested artifact is the artifact running in Deploy Commander.

**Architecture:** A pure discriminated-union reducer owns action-gate transitions. `App` mounts a recognized child action without waiting for caller discovery; the create/delete request component shows the gate immediately, resolves the authoritative caller inside the visible preparation phase, and then runs existing read-only preparation. Specialized dialogs compose a shared modal frame, while a build marker and publish smoke procedure close the local-test-to-runtime gap.

**Tech Stack:** React 19.2, TypeScript 5.9, `@ezenki/deploy-commander-installer-interface` 0.5, Vitest 4, Testing Library, ESLint 9, Prettier 3, Vite 7

**Spec:** `docs/superpowers/specs/2026-09-19-postgres-action-approval-gate-design.md`

## Global Constraints

- Execute product commands from `postgres-interface/` unless a step says otherwise.
- Use jCodeMunch for code navigation, symbol inspection, and reference discovery.
- Use an authoritative caller only from `RPCCaller.getCallingManager()`; never read caller identity from request metadata.
- Every create, delete, install, and teardown mutation requires explicit approval for that request.
- Read-only preparation may run before approval; `start`, `createConnection`, `deleteConnection`, and mutating database queries may not.
- Never persist or remember approval.
- Never render or log administrator credentials, logical credentials, raw metadata, connection strings, or raw transport failures.
- Preserve run-backed lifecycle and connection recovery behavior.
- Do not change runner image names, runner action names, resource identity, connection schema, or wire protocol.
- Add no runtime dependency.
- Start every behavior change with a failing test and observe the expected failure before implementation.
- The working tree already contains provisional uncommitted approval changes in `App.tsx`, the create/delete request/dialog files, and dashboard confirmation files. Inspect those diffs before each task, preserve useful in-scope work, and do not discard or overwrite unrelated hunks.
- Before each commit, inspect the staged diff and stage only the task-owned result; do not assume a whole-file add is safe merely because the file is listed in the task.
- Publishing is an external state change. Run `npm run publish:manager` only after explicit user authorization.

## Review Focus

- `getCallingManager()` is pending, returns `null`, or rejects: mount the gate before waiting, then show a blocked gate for failure with no enabled approval or mutation; covered in Tasks 3 and 4.
- Metadata identifies an action but fails parsing: show a blocked gate and avoid discovery/mutation; covered in Tasks 3 and 4.
- Preparation remains pending or fails after the gate appears: keep the gate visible and cancellable; covered in Tasks 3 and 4.
- Rerenders, StrictMode replay, and run events occur around approval: preparation and execution remain single-shot; covered in Tasks 3 and 4.
- Local tests pass but the host serves an older artifact: expose and verify the build marker before host smoke tests; covered in Tasks 2 and 6.

---

### Task 1: Pure Action-Gate State Machine

**Files:**

- Create: `postgres-interface/src/lib/actionGate.ts`
- Create: `postgres-interface/src/lib/actionGate.test.ts`

**Interfaces:**

- Consumes: normalized parsing/preparation failures and authoritative caller-resolution events from request components.
- Produces: `ActionGateFailure`, `ActionGateState<Context>`, `ActionGateEvent<Context>`, `initialActionGate`, and `actionGateReducer`.

- [ ] **Step 1: Write failing state-transition tests**

Create `src/lib/actionGate.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the state test and verify the missing-module failure**

Run:

```bash
npx vitest run src/lib/actionGate.test.ts
```

Expected: FAIL because `./actionGate` does not exist.

- [ ] **Step 3: Implement the minimal pure reducer**

Create `src/lib/actionGate.ts`:

```ts
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
```

- [ ] **Step 4: Run the state tests**

Run:

```bash
npx vitest run src/lib/actionGate.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit the state model**

```bash
git add postgres-interface/src/lib/actionGate.ts postgres-interface/src/lib/actionGate.test.ts
git commit -m "feat: model postgres action approval states"
```

---

### Task 2: Shared Approval Dialog Frame and Build Marker

**Files:**

- Create: `postgres-interface/src/components/ActionApprovalDialog.tsx`
- Create: `postgres-interface/src/components/ActionApprovalDialog.test.tsx`
- Create: `postgres-interface/src/lib/buildInfo.ts`
- Modify: `postgres-interface/src/components/ManagerShell.tsx`
- Modify: `postgres-interface/src/components/OperationalUI.test.tsx`

**Interfaces:**

- Consumes: `ActionGateState<Context>`, `ActionButton`, and `useDialogFocus`.
- Produces: reusable modal semantics for preparing, blocked, ready, and executing request views; `MANAGER_BUILD_MARKER` for runtime identification.

- [ ] **Step 1: Write failing dialog-frame tests**

Create `src/components/ActionApprovalDialog.test.tsx` with these assertions:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ActionApprovalDialog from './ActionApprovalDialog';

afterEach(cleanup);

describe('ActionApprovalDialog', () => {
  it('keeps a preparing request modal and cancellable', async () => {
    const user = userEvent.setup();
    const reject = vi.fn();
    render(
      <ActionApprovalDialog
        title="Approve PostgreSQL access?"
        callerId="consumer-manager"
        phase="preparing"
        status="Checking PostgreSQL installation"
        onReject={reject}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Checking PostgreSQL installation');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(reject).toHaveBeenCalledOnce();
  });

  it('renders a missing caller as blocked without an approve action', () => {
    render(
      <ActionApprovalDialog
        title="Approve PostgreSQL access?"
        callerId={null}
        phase="blocked"
        error="A calling manager is required"
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('A calling manager is required');
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });
});
```

Extend `src/components/OperationalUI.test.tsx`:

```tsx
expect(screen.getByRole('main')).toHaveAttribute(
  'data-manager-build',
  'postgres-action-approval-gate-v1',
);
```

- [ ] **Step 2: Run the tests and verify expected failures**

Run:

```bash
npx vitest run src/components/ActionApprovalDialog.test.tsx src/components/OperationalUI.test.tsx
```

Expected: FAIL because the dialog frame and build marker do not exist.

- [ ] **Step 3: Add the build marker**

Create `src/lib/buildInfo.ts`:

```ts
export const MANAGER_BUILD_MARKER = 'postgres-action-approval-gate-v1';
```

Import it in `ManagerShell.tsx` and add it to the existing `<main>`:

```tsx
<main
  data-manager-build={MANAGER_BUILD_MARKER}
  className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 sm:py-10 lg:px-8"
>
```

- [ ] **Step 4: Implement the shared dialog frame**

Create `src/components/ActionApprovalDialog.tsx` with explicit props:

```ts
export interface ActionApprovalDialogProps {
  title: string;
  callerId: string | null;
  phase: 'preparing' | 'ready' | 'blocked' | 'executing';
  status?: string;
  error?: string;
  children?: ReactNode;
  primaryAction?: ReactNode;
  retryAction?: ReactNode;
  rejectLabel?: string;
  onReject: () => void;
}
```

Use the existing overlay classes and `useDialogFocus`. The frame must:

- label the dialog with `title` in every phase;
- render `callerId ?? (phase === 'preparing' ? 'Identifying…' : 'Unavailable')`;
- render `status` with `role="status"` in preparing/executing;
- render `error` with `role="alert"` in blocked;
- render `primaryAction` only in ready/executing and `retryAction` only in blocked;
- disable Reject only during executing;
- render `children` only in ready or executing.

- [ ] **Step 5: Run the focused tests**

Run:

```bash
npx vitest run src/components/ActionApprovalDialog.test.tsx src/components/OperationalUI.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the shared UI and marker**

```bash
git add postgres-interface/src/components/ActionApprovalDialog.tsx postgres-interface/src/components/ActionApprovalDialog.test.tsx postgres-interface/src/components/ManagerShell.tsx postgres-interface/src/components/OperationalUI.test.tsx postgres-interface/src/lib/buildInfo.ts
git commit -m "feat: add visible postgres action gate shell"
```

---

### Task 3: Create-Connection Gate Across All Prerequisite States

**Files:**

- Modify: `postgres-interface/src/App.tsx`
- Modify: `postgres-interface/src/App.test.tsx`
- Modify: `postgres-interface/src/components/ConnectionApprovalDialog.tsx`
- Modify: `postgres-interface/src/components/ConnectionApprovalDialog.test.tsx`
- Modify: `postgres-interface/src/components/ConnectionRequest.tsx`
- Modify: `postgres-interface/src/components/ConnectionRequest.test.tsx`

**Interfaces:**

- Consumes: `ActionGateState<ApprovalContext>`, `initialActionGate`, `actionGateReducer`, existing `createPostgresConnection`, and the shared dialog frame.
- Produces: a create request that mounts before caller lookup, remains represented by a visible gate, and enters execution only from `ready` after one explicit approval.

- [ ] **Step 1: Add App-level failing regressions for the observed branch**

Add to `src/App.test.tsx`:

```tsx
it('shows create approval while caller lookup is pending', async () => {
  const current = fixture(
    { getCallingManager: vi.fn(() => new Promise(() => undefined)) },
    { action: 'create-connection', scope: 'database', operation: 'create', database: 'orders' },
  );
  render(<App createClient={current.factory} />);

  expect(await screen.findByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Identifying the calling manager');
  expect(current.caller.getMyResources).not.toHaveBeenCalled();
  expect(current.caller.start).not.toHaveBeenCalled();
});

it.each([
  ['missing', vi.fn().mockResolvedValue(null)],
  ['failed', vi.fn().mockRejectedValue(new Error('transport detail'))],
])('shows a blocked create approval when caller lookup is %s', async (_case, getCallingManager) => {
  const current = fixture(
    { getCallingManager },
    { action: 'create-connection', scope: 'database', operation: 'create', database: 'orders' },
  );
  render(<App createClient={current.factory} />);

  expect(await screen.findByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('A calling manager is required');
  expect(screen.queryByRole('button', { name: 'Approve connection' })).not.toBeInTheDocument();
  expect(current.caller.start).not.toHaveBeenCalled();
});
```

Add an invalid-metadata case that expects the same dialog with `Invalid PostgreSQL connection request` and asserts `getCallingManager`, `getMyResources`, `databaseQuery`, and `start` were not called. This proves `App` mounts the recognized child immediately but does not perform unrelated discovery for an unparseable request.

- [ ] **Step 2: Add component-level failing regressions**

In `ConnectionRequest.test.tsx`, add tests for:

```tsx
it('shows a blocked gate instead of progress-only UI for initial errors', () => {
  render(
    <ConnectionRequest
      {...baseProps({} as RPCCaller, { close: vi.fn() } as unknown as Wire)}
      initialError="Invalid PostgreSQL connection request"
    />,
  );
  expect(screen.getByRole('dialog', { name: 'Approve PostgreSQL access?' })).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('Invalid PostgreSQL connection request');
});
```

Add a deferred `getCallingManager` test that sees the preparing dialog before resolving the promise. Extend the pending resource-preparation test to assert Reject closes once with status 499 and `start` remains uncalled. Add a double-click approval test that expects one `create-connection` start.

- [ ] **Step 3: Run create-focused tests and verify the progress-only failure**

Run:

```bash
npx vitest run src/App.test.tsx src/components/ConnectionRequest.test.tsx src/components/ConnectionApprovalDialog.test.tsx
```

Expected: FAIL because `App` waits for caller lookup and `initialError`/missing caller still suppress approval.

- [ ] **Step 4: Replace nullable approval state with the reducer**

In `ConnectionRequest.tsx`:

- remove `callingManagerId` from `ConnectionRequestProps`; `App` no longer resolves or supplies it;
- initialize `useReducer(actionGateReducer<ApprovalContext>, initialActionGate(normalizedInitialFailure))` synchronously during the first render;
- for valid metadata, call `caller.getCallingManager()` once per preparation attempt, normalize it with the same nonblank-string rule as manager identity, and dispatch `blocked` with status 400 when it returns `null` or rejects;
- after a valid caller resolves, dispatch `identified`, then pass that exact ID to `createPostgresConnection`;
- render the dialog for every gate state except `closed`; executing always retains its approved review context;
- dispatch `prepared` with the resolved caller ID from the existing `requestApproval(context)` callback;
- dispatch `approve` before resolving `{ allowed: true, access }`;
- dispatch `close` on rejection and use the existing `closeOnce`/abort behavior;
- dispatch `blocked` for normalized preparation failures instead of removing the dialog;
- use an incrementing preparation-attempt key for Retry, abort the prior attempt, and never overlap caller/workflow discovery;
- keep the workflow promise pending only while the gate awaits a valid decision;
- dispatch `complete` and close the wire for success or failures that occur after the gate entered `executing`; preparation failures remain visible in `blocked`.

Do not use a fabricated `ApprovalContext` while preparing. Pass the gate directly to `ConnectionApprovalDialog`.

- [ ] **Step 5: Compose `ConnectionApprovalDialog` with the shared frame**

Change its public interface to:

```ts
export interface ConnectionApprovalDialogProps {
  gate: ActionGateState<ApprovalContext>;
  request: ParsedConnectionRequest;
  onApprove: (access: AccessRequest) => void;
  onReject: () => void;
  onRetry: () => void;
  generateName?: () => string;
}
```

Map phases as follows:

- preparing with no caller: status `Identifying the calling manager…`;
- preparing with a caller: status `Checking PostgreSQL installation and available databases before approval…`;
- ready: render current request summary/configuration and Approve button;
- blocked: render the normalized gate failure and Retry only when `failure.retryable`;
- executing: retain the ready context and status `Creating PostgreSQL connection…`.

- [ ] **Step 6: Remove raw App logging and preserve normalized prerequisite failures**

Delete the two raw `console.log` calls from `App.tsx`. Remove `callerId` from both child-view types and remove `getCallingManager()` from `App.boot()`. After action recognition and metadata parsing, return the child view immediately. Continue passing a normalized parsing error into `ConnectionRequest`; the component represents it as a blocked gate and skips caller lookup. Valid requests perform caller lookup inside the already-visible preparation gate.

- [ ] **Step 7: Run create-focused tests**

Run:

```bash
npx vitest run src/App.test.tsx src/components/ConnectionRequest.test.tsx src/components/ConnectionApprovalDialog.test.tsx src/lib/createPostgresConnection.test.ts --testNamePattern='create|connection mode|passes complete|approved child|malformed connection'
```

Expected: PASS for the create-focused App and component tests. Delete-routing assertions in the shared App suite are completed in Task 4.

- [ ] **Step 8: Commit the create gate**

```bash
git add postgres-interface/src/App.tsx postgres-interface/src/App.test.tsx postgres-interface/src/components/ConnectionApprovalDialog.tsx postgres-interface/src/components/ConnectionApprovalDialog.test.tsx postgres-interface/src/components/ConnectionRequest.tsx postgres-interface/src/components/ConnectionRequest.test.tsx
git commit -m "fix: keep create connection approval visible"
```

---

### Task 4: Delete-Connection Gate Across All Prerequisite States

**Files:**

- Modify: `postgres-interface/src/App.test.tsx`
- Modify: `postgres-interface/src/components/DeleteConnectionDialog.tsx`
- Modify: `postgres-interface/src/components/DeleteConnectionDialog.test.tsx`
- Modify: `postgres-interface/src/components/DeleteConnectionRequest.tsx`
- Modify: `postgres-interface/src/components/DeleteConnectionRequest.test.tsx`

**Interfaces:**

- Consumes: `ActionGateState<DeleteConnectionApprovalContext>`, the pure reducer, existing `deletePostgresConnection`, and the shared dialog frame.
- Produces: a delete request that mounts before caller lookup, remains visible while caller/ownership checks run, and cannot execute without a valid owned choice plus explicit approval.

- [ ] **Step 1: Add App-level failing missing/rejected-caller tests**

Mirror Task 3 using metadata `{ action: 'delete-connection', connection: 'connection-1' }`. Include a deferred `getCallingManager` case proving the dialog and `Identifying the calling manager` status render before the promise resolves. For missing/rejected caller, assert:

```tsx
expect(await screen.findByRole('dialog', { name: 'Delete PostgreSQL connection?' })).toBeVisible();
expect(screen.getByRole('alert')).toHaveTextContent('A calling manager is required');
expect(screen.queryByRole('button', { name: 'Delete connection' })).not.toBeInTheDocument();
expect(current.caller.start).not.toHaveBeenCalled();
expect(current.caller.deleteConnection).not.toHaveBeenCalled();
```

Add malformed delete metadata coverage and assert no resource/connection discovery.

- [ ] **Step 2: Add component-level failing preparation, rejection, and one-shot tests**

In `DeleteConnectionRequest.test.tsx`:

- pending `getConnections` keeps the dialog visible;
- pending `getCallingManager` keeps the dialog visible and performs no ownership discovery;
- Cancel during pending preparation closes once and starts/deletes nothing;
- rejected or missing caller renders a blocked dialog;
- double-clicking Delete starts one cleanup run and one final delete at most.

- [ ] **Step 3: Run delete-focused tests and verify failure**

Run:

```bash
npx vitest run src/App.test.tsx src/components/DeleteConnectionRequest.test.tsx src/components/DeleteConnectionDialog.test.tsx
```

Expected: FAIL because blocked delete requests still suppress the dialog.

- [ ] **Step 4: Move delete request state to the reducer**

In `DeleteConnectionRequest.tsx`:

- remove `callingManagerId` from its props and initialize from `initialActionGate(normalizedInitialFailure)`;
- for valid metadata, resolve `caller.getCallingManager()` once per preparation attempt before ownership discovery; dispatch `identified` for a valid nonblank ID and `blocked` status 400 for `null`/rejection;
- dispatch `prepared` with that resolved caller ID only from `requestApproval(context)` after ownership discovery;
- dispatch `approve` before resolving the selected ID;
- reject preparation by aborting and closing 499;
- reject ready state through the existing denied decision;
- map discovery/recovery errors to `blocked` instead of progress-only closure;
- retry with a new non-overlapping caller/discovery attempt;
- dispatch `complete` before closing the wire after execution;
- retain `closeOnce`, abort cleanup, and pre-delete ownership revalidation.

- [ ] **Step 5: Compose the delete dialog with the shared frame**

Change its public interface to:

```ts
export interface DeleteConnectionDialogProps {
  gate: ActionGateState<DeleteConnectionApprovalContext>;
  request: ParsedDeleteConnectionRequest;
  onApprove: (connectionId: string) => void;
  onReject: () => void;
  onRetry: () => void;
}
```

Preparing copy is `Identifying the calling manager…` until the caller resolves, then `Checking connection ownership before approval…`. Ready state keeps the existing owned-choice UI. Blocked state omits Delete. Executing state retains the approved choice and shows `Deleting PostgreSQL connection…`.

- [ ] **Step 6: Run delete-focused and ownership tests**

Run:

```bash
npx vitest run src/App.test.tsx src/components/DeleteConnectionRequest.test.tsx src/components/DeleteConnectionDialog.test.tsx src/lib/deletePostgresConnection.test.ts src/lib/postgresConnectionContract.test.ts
```

Expected: PASS with zero mutation assertions before approval.

- [ ] **Step 7: Commit the delete gate**

```bash
git add postgres-interface/src/App.test.tsx postgres-interface/src/components/DeleteConnectionDialog.tsx postgres-interface/src/components/DeleteConnectionDialog.test.tsx postgres-interface/src/components/DeleteConnectionRequest.tsx postgres-interface/src/components/DeleteConnectionRequest.test.tsx
git commit -m "fix: keep delete connection approval visible"
```

---

### Task 5: Audit Install and Teardown Confirmation as One-Shot Gates

**Files:**

- Modify: `postgres-interface/src/components/ConfirmDialog.tsx`
- Modify: `postgres-interface/src/components/ConfirmDialog.test.tsx`
- Modify: `postgres-interface/src/components/ManagerDashboard.tsx`
- Modify: `postgres-interface/src/components/ManagerDashboard.test.tsx`

**Interfaces:**

- Consumes: existing `onInstall` and `onTeardown` callbacks.
- Produces: action-specific confirmation copy and one-shot dashboard submission for both lifecycle mutations.

- [ ] **Step 1: Add failing confirmation tests for all lifecycle entry points**

Cover fresh installation, installation retry, normal teardown, teardown retry, and recovery teardown. Each test must click the visible dashboard button once and assert the callback remains uncalled until confirmation.

Add this double-confirmation test:

```tsx
fireEvent.click(screen.getByRole('button', { name: 'Install PostgreSQL' }));
const confirm = screen.getByRole('button', { name: 'Confirm installation' });
fireEvent.click(confirm);
fireEvent.click(confirm);
expect(onInstall).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Run dashboard/dialog tests and verify uncovered paths fail**

Run:

```bash
npx vitest run src/components/ManagerDashboard.test.tsx src/components/ConfirmDialog.test.tsx
```

Expected: FAIL for any install/teardown entry point that still invokes directly or allows a second submission.

- [ ] **Step 3: Finish the parameterized confirmation behavior**

Keep these `ConfirmDialog` props:

```ts
title?: string;
description?: ReactNode;
confirmLabel?: string;
busyMessage?: string;
tone?: ActionTone;
```

Use `requestInstall` for both fresh and retry installation. Use `requestTeardown` for every teardown entry point. Guard each confirm callback with its submitted state before invoking the parent callback.

- [ ] **Step 4: Run lifecycle confirmation tests**

Run:

```bash
npx vitest run src/components/ManagerDashboard.test.tsx src/components/ConfirmDialog.test.tsx src/App.test.tsx src/lib/lifecycleActions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit lifecycle confirmation coverage**

```bash
git add postgres-interface/src/components/ConfirmDialog.tsx postgres-interface/src/components/ConfirmDialog.test.tsx postgres-interface/src/components/ManagerDashboard.tsx postgres-interface/src/components/ManagerDashboard.test.tsx
git commit -m "test: enforce approval for lifecycle actions"
```

---

### Task 6: Full Verification, Artifact Proof, and Authorized Host Smoke Test

**Files:**

- Modify only if a verification failure requires an in-scope correction.
- Verify: `postgres-interface/dist/index.html`
- Verify: `postgres-interface/dist/assets/*.js`
- Verify: `postgres-interface/deploy-commander.json`

**Interfaces:**

- Consumes: all implementation tasks and the `dist` publication contract.
- Produces: fresh test/build evidence and, only with authorization, a published manager verified in the real host flow.

- [ ] **Step 1: Run focused approval suites together**

```bash
npx vitest run src/lib/actionGate.test.ts src/components/ActionApprovalDialog.test.tsx src/components/ConnectionApprovalDialog.test.tsx src/components/ConnectionRequest.test.tsx src/components/DeleteConnectionDialog.test.tsx src/components/DeleteConnectionRequest.test.tsx src/components/ConfirmDialog.test.tsx src/components/ManagerDashboard.test.tsx src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run the complete quality gate**

```bash
npm test
npm run lint
npm run format:check
npm run build
```

Expected: every command exits 0. Record the Vitest passed/skipped counts.

- [ ] **Step 3: Prove the built artifact contains the approval implementation**

From the repository root:

```bash
rg -l "postgres-action-approval-gate-v1" postgres-interface/dist/assets/*.js
rg -l "Approve PostgreSQL access\?|Delete PostgreSQL connection\?|A calling manager is required" postgres-interface/dist/assets/*.js
```

Expected: both commands name the current generated JavaScript asset.

- [ ] **Step 4: Inspect the final diff and preserve unrelated changes**

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors. Confirm only task files plus previously existing user changes are present.

- [ ] **Step 5: Stop and obtain explicit publication authorization**

Report the local verification and exact build marker. Do not publish until the user explicitly authorizes the external state change.

- [ ] **Step 6: Publish the verified artifact after authorization**

From `postgres-interface/`:

```bash
npm run publish:manager
```

Expected: `deploy-commander publish` completes successfully using `deploy-commander.json` and its `dist` build directory.

- [ ] **Step 7: Run real host smoke scenarios**

In the published manager UI:

1. Inspect the manager root and confirm `data-manager-build="postgres-action-approval-gate-v1"`.
2. Request create-connection with a valid caller. Confirm the approval dialog appears before any run and approval starts one `create-connection` run.
3. Request create-connection without an authoritative caller. Confirm a blocked dialog appears and no run starts.
4. Reject a valid create request. Confirm no run starts and the child interface receives status 499.
5. Request delete-connection. Confirm its gate appears before ownership discovery completes and approval starts at most one cleanup run.
6. Reject deletion. Confirm neither cleanup nor `deleteConnection` runs.

- [ ] **Step 8: Record final evidence**

Report:

- test totals;
- lint, formatting, and build exit status;
- generated asset containing the marker;
- publish command result;
- create and delete smoke outcomes;
- any host contract failure, especially `getCallingManager() === null`, without exposing raw metadata or credentials.
