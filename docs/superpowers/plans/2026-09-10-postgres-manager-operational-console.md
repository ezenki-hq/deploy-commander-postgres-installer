# PostgreSQL Manager Operational Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every PostgreSQL manager view into a cohesive, accessible Tailwind operational console with accurate progress states and guarded teardown.

**Architecture:** Small Tailwind presentation components provide the shared shell, status panels, and action variants. `App` exposes explicit install/teardown action state, while `ManagerDashboard`, connection progress, and both dialogs compose the shared primitives without taking ownership of provisioning logic.

**Tech Stack:** React 19.2, TypeScript 5.9, Tailwind CSS 4.1, Vitest 4, Testing Library, ESLint 9, Vite 7

**Spec:** `docs/superpowers/specs/2026-09-10-postgres-manager-operational-console-design.md`

## Global Constraints

- Complete `docs/superpowers/plans/2026-09-10-postgres-manager-database-bootstrap.md` first.
- Execute commands from `postgres-interface/` unless a step says otherwise.
- Use jCodeMunch for code navigation and symbol/reference discovery.
- Do not add a component library, icon package, font download, image asset, or any other dependency.
- Use the existing Tailwind CSS 4 Vite integration and standard system fonts.
- Keep this iteration light-theme only.
- Support a 320-pixel viewport without horizontal page overflow.
- Never render or log administrator credentials, logical credentials, connection strings, or raw runner/database failures.
- Color and icons may reinforce meaning but cannot be the only indicators.
- Every behavior change starts with a failing test or failing static check.
- Keep commits scoped to the task that produced them.

---

### Task 1: Shared Operational Console Primitives

**Files:**

- Create: `postgres-interface/src/components/ActionButton.tsx`
- Create: `postgres-interface/src/components/ManagerShell.tsx`
- Create: `postgres-interface/src/components/StatusPanel.tsx`
- Create: `postgres-interface/src/components/OperationalUI.test.tsx`

**Interfaces:**

- Consumes: React button and node types; Tailwind utility classes.
- Produces: `ActionButton`, `ManagerShell`, `StatusPanel`, and their exported prop/tone types.

- [ ] **Step 1: Write failing semantic tests for the primitives**

Create `src/components/OperationalUI.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ActionButton from './ActionButton';
import ManagerShell from './ManagerShell';
import StatusPanel from './StatusPanel';

afterEach(cleanup);

describe('operational console primitives', () => {
  it('provides one labelled manager shell with an optional health badge', () => {
    render(
      <ManagerShell badge={{ label: 'Ready', tone: 'success' }}>
        <p>Manager content</p>
      </ManagerShell>,
    );

    expect(screen.getByRole('heading', { name: 'PostgreSQL manager' })).toBeVisible();
    expect(screen.getByText('Ready')).toBeVisible();
    expect(screen.getByText('Manager content')).toBeVisible();
  });

  it('announces status and alert panels according to their role', () => {
    const view = render(
      <StatusPanel tone="progress" title="Installing PostgreSQL" role="status">
        Persistent storage is being prepared.
      </StatusPanel>,
    );
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');

    view.rerender(
      <StatusPanel tone="danger" title="Storage unavailable" role="alert">
        Retry manager initialization.
      </StatusPanel>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Storage unavailable');
  });

  it('keeps action variants accessible and single-shot while disabled', async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    const view = render(
      <ActionButton tone="danger" disabled onClick={action}>
        Confirm teardown
      </ActionButton>,
    );
    await user.click(screen.getByRole('button', { name: 'Confirm teardown' }));
    expect(action).not.toHaveBeenCalled();

    view.rerender(
      <ActionButton tone="primary" onClick={action}>
        Install PostgreSQL
      </ActionButton>,
    );
    await user.click(screen.getByRole('button', { name: 'Install PostgreSQL' }));
    expect(action).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the primitive tests and verify missing-module failures**

```bash
npx vitest run src/components/OperationalUI.test.tsx
```

Expected: FAIL because the three components do not exist.

- [ ] **Step 3: Implement `ActionButton` with three explicit variants**

Create `src/components/ActionButton.tsx`:

```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ActionTone = 'primary' | 'secondary' | 'danger';

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ActionTone;
  children: ReactNode;
}

const toneClasses: Record<ActionTone, string> = {
  primary:
    'bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 focus-visible:outline-indigo-600',
  secondary:
    'border border-slate-300 bg-white text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-slate-500',
  danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-500 focus-visible:outline-rose-600',
};

export default function ActionButton({
  tone = 'primary',
  className = '',
  type = 'button',
  children,
  ...props
}: ActionButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex min-h-11 items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${toneClasses[tone]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 4: Implement the shared shell**

Create `src/components/ManagerShell.tsx`:

```tsx
import type { ReactNode } from 'react';

export type ShellBadgeTone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

export interface ManagerShellProps {
  children: ReactNode;
  badge?: { label: string; tone: ShellBadgeTone };
}

const badgeClasses: Record<ShellBadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  progress: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  danger: 'bg-rose-50 text-rose-700 ring-rose-200',
};

export default function ManagerShell({ children, badge }: ManagerShellProps) {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 sm:py-10 lg:px-8">
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">
              Deploy Commander
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              PostgreSQL manager
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Manage the shared PostgreSQL service and its logical database connections.
            </p>
          </div>
          {badge && (
            <span
              className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset ${badgeClasses[badge.tone]}`}
            >
              {badge.label}
            </span>
          )}
        </header>
        {children}
      </div>
    </main>
  );
}
```

- [ ] **Step 5: Implement semantic status panels**

Create `src/components/StatusPanel.tsx`:

```tsx
import type { HTMLAttributes, ReactNode } from 'react';

export type StatusTone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

export interface StatusPanelProps extends Pick<HTMLAttributes<HTMLElement>, 'role'> {
  tone: StatusTone;
  title: string;
  eyebrow?: string;
  badge?: string;
  children: ReactNode;
  actions?: ReactNode;
}

const panelClasses: Record<StatusTone, string> = {
  neutral: 'border-slate-200 bg-white',
  progress: 'border-indigo-200 bg-white',
  success: 'border-emerald-200 bg-white',
  warning: 'border-amber-200 bg-white',
  danger: 'border-rose-200 bg-white',
};
const eyebrowClasses: Record<StatusTone, string> = {
  neutral: 'text-slate-600',
  progress: 'text-indigo-700',
  success: 'text-emerald-700',
  warning: 'text-amber-800',
  danger: 'text-rose-700',
};

export default function StatusPanel({
  tone,
  title,
  eyebrow,
  badge,
  children,
  actions,
  role,
}: StatusPanelProps) {
  return (
    <section
      role={role}
      aria-live={role === 'status' ? 'polite' : undefined}
      className={`rounded-2xl border p-5 shadow-sm sm:p-7 ${panelClasses[tone]}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <p className={`text-xs font-bold uppercase tracking-[0.16em] ${eyebrowClasses[tone]}`}>
              {eyebrow}
            </p>
          )}
          <h2 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{title}</h2>
        </div>
        {badge && (
          <span className="w-fit rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            {badge}
          </span>
        )}
      </div>
      <div className="mt-4 text-sm leading-6 text-slate-600">{children}</div>
      {actions && (
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">{actions}</div>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Run focused tests, lint, and commit**

```bash
npx vitest run src/components/OperationalUI.test.tsx
npx eslint src/components/ActionButton.tsx src/components/ManagerShell.tsx src/components/StatusPanel.tsx src/components/OperationalUI.test.tsx
git add src/components/ActionButton.tsx src/components/ManagerShell.tsx src/components/StatusPanel.tsx src/components/OperationalUI.test.tsx
git commit -m "feat: add operational console primitives"
```

Expected: tests PASS, ESLint exits zero, and the commit succeeds.

---

### Task 2: Explicit Lifecycle Progress and Redesigned Dashboard

**Files:**

- Modify: `postgres-interface/src/App.tsx:79-198`
- Modify: `postgres-interface/src/components/ManagerDashboard.tsx:4-140`
- Modify: `postgres-interface/src/components/ManagerDashboard.test.tsx:19-95`

**Interfaces:**

- Consumes: `ManagerShell`, `StatusPanel`, and `ActionButton` from Task 1.
- Produces: `LifecycleAction = 'install' | 'teardown' | null` and `ManagerDashboardProps.activeAction`.

- [ ] **Step 1: Add failing tests for truthful action progress and single errors**

Replace the test helper's `busy={false}` with `activeAction={null}`, then add:

```tsx
it('describes normal installation progress without recovery wording', () => {
  renderDashboard({ activeAction: 'install' });
  expect(screen.getByRole('status')).toHaveTextContent('Installing PostgreSQL');
  expect(screen.queryByText(/needs recovery/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Install PostgreSQL' })).not.toBeInTheDocument();
});

it('describes normal teardown progress without recovery wording', () => {
  renderDashboard({ resource, primary, activeAction: 'teardown' });
  expect(screen.getByRole('status')).toHaveTextContent('Tearing down PostgreSQL');
  expect(screen.queryByText(/needs recovery/i)).not.toBeInTheDocument();
});

it('renders a supplied recovery error exactly once', () => {
  renderDashboard({ error: 'PostgreSQL recovery is required', primary });
  expect(screen.getAllByText('PostgreSQL recovery is required')).toHaveLength(1);
});
```

Update the existing busy recovery test to use `activeAction={null}` and retain
its incomplete persisted state. Recovery is caused by that state, not by a
generic busy flag.

- [ ] **Step 2: Run the dashboard tests and verify the prop/behavior failures**

```bash
npx vitest run src/components/ManagerDashboard.test.tsx
```

Expected: FAIL because `activeAction` does not exist and normal progress panels
are not implemented.

- [ ] **Step 3: Replace the generic busy prop with explicit action state**

In `ManagerDashboard.tsx` export:

```ts
export type LifecycleAction = 'install' | 'teardown' | null;
```

Replace `busy: boolean` with `activeAction: LifecycleAction`, then derive:

```ts
const busy = activeAction !== null;
```

Handle action progress before error/recovery branches:

```tsx
if (activeAction === 'install') {
  content = (
    <StatusPanel
      tone="progress"
      eyebrow="Installation in progress"
      title="Installing PostgreSQL"
      role="status"
    >
      The shared service and persistent storage are being prepared. This can take a few minutes.
    </StatusPanel>
  );
} else if (activeAction === 'teardown') {
  content = (
    <StatusPanel
      tone="progress"
      eyebrow="Teardown in progress"
      title="Tearing down PostgreSQL"
      role="status"
    >
      The shared service and its logical databases are being removed safely.
    </StatusPanel>
  );
}
```

After those branches, preserve distinct ambiguous, explicit error,
teardown-failed, ready, legacy, persisted recovery, and not-installed branches.
Compose each with `StatusPanel` and `ActionButton`. Remove the standalone error
banner so the same error appears only inside its panel.

Wrap the selected panel in `ManagerShell`. Derive its badge from the selected
state using `Installing`, `Tearing down`, `Ready`, `Attention`, `Recovery`, or
`Not installed` and the matching tone.

- [ ] **Step 4: Preserve ready-state privacy and add operational details**

Inside the ready panel, use this non-secret detail grid:

```tsx
<dl className="mt-5 grid gap-4 rounded-xl bg-slate-50 p-4 sm:grid-cols-2">
  <div className="min-w-0">
    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Resource</dt>
    <dd className="mt-1 break-all font-mono text-sm text-slate-800">{resource?.id}</dd>
  </div>
  <div>
    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
      Connection approval
    </dt>
    <dd className="mt-1 text-sm text-slate-800">
      {permissionRemembered ? 'Remembered for this installation' : 'Requested for each caller'}
    </dd>
  </div>
</dl>
```

Keep reset approval in the normal action group. Put teardown in a separate
rose-tinted danger zone; its click remains direct until Task 3. Never render a
property from `primary.credentials`.

- [ ] **Step 5: Track action kind in `App`**

Replace `actionBusy` with:

```ts
const [activeAction, setActiveAction] = useState<LifecycleAction>(null);
```

Change `runAction` to:

```ts
const runAction = async (
  kind: Exclude<LifecycleAction, null>,
  action: (signal: AbortSignal) => Promise<void>,
) => {
  if (activeAction !== null) return;
  const controller = new AbortController();
  actionControllerRef.current = controller;
  setActiveAction(kind);
  setActionError(null);
  try {
    await action(controller.signal);
    requestRefresh();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return;
    setActionError(
      error instanceof Error && error.message.includes('recovery')
        ? 'PostgreSQL recovery is required'
        : 'Unable to complete PostgreSQL lifecycle action',
    );
  } finally {
    if (actionControllerRef.current === controller) {
      actionControllerRef.current = null;
    }
    setActiveAction(null);
  }
};
```

Pass `activeAction` to `ManagerDashboard` and use these callbacks:

```tsx
onInstall={() => {
  void runAction('install', (signal) => installPostgres({
    caller: appClient.caller,
    events: appClient.events,
    signal,
  }));
}}
onTeardown={() => {
  if (!view.resource) return;
  void runAction('teardown', (signal) => teardownPostgres({
    caller: appClient.caller,
    events: appClient.events,
    signal,
    managerId: manager || undefined,
    storage,
  }, view.resource));
}}
```

- [ ] **Step 6: Run focused checks and commit**

```bash
npx vitest run src/components/ManagerDashboard.test.tsx src/App.test.tsx
npx eslint src/App.tsx src/components/ManagerDashboard.tsx src/components/ManagerDashboard.test.tsx
git add src/App.tsx src/components/ManagerDashboard.tsx src/components/ManagerDashboard.test.tsx
git commit -m "feat: present explicit PostgreSQL lifecycle states"
```

Expected: focused tests PASS, errors render once, and ESLint exits zero.

---

### Task 3: Accessible Teardown Confirmation

**Files:**

- Create: `postgres-interface/src/components/useDialogFocus.ts`
- Create: `postgres-interface/src/components/ConfirmDialog.tsx`
- Create: `postgres-interface/src/components/ConfirmDialog.test.tsx`
- Modify: `postgres-interface/src/components/ManagerDashboard.tsx`
- Modify: `postgres-interface/src/components/ManagerDashboard.test.tsx`

**Interfaces:**

- Consumes: `ActionButton` and `LifecycleAction`.
- Produces: `useDialogFocus<T extends HTMLElement>(canDismiss: boolean, onDismiss: () => void): RefObject<T | null>` and `ConfirmDialog`.

- [ ] **Step 1: Write failing keyboard, focus, and confirmation tests**

Create `src/components/ConfirmDialog.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfirmDialog from './ConfirmDialog';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  it('labels the destructive effect and calls confirm once', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmDialog busy={false} onCancel={vi.fn()} onConfirm={onConfirm} />);

    expect(screen.getByRole('dialog', { name: 'Teardown PostgreSQL?' })).toHaveAttribute(
      'aria-modal',
      'true',
    );
    expect(screen.getByText(/shared service and its logical databases/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Confirm teardown' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('traps focus, handles Escape, and restores focus on unmount', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    opener.textContent = 'Teardown PostgreSQL';
    document.body.append(opener);
    opener.focus();
    const onCancel = vi.fn();
    const view = render(<ConfirmDialog busy={false} onCancel={onCancel} onConfirm={vi.fn()} />);

    expect(screen.getByRole('dialog')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Confirm teardown' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('disables dismissal and confirmation while busy', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmDialog busy onCancel={onCancel} onConfirm={onConfirm} />);

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirm teardown' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the dialog tests and verify the missing-module failure**

```bash
npx vitest run src/components/ConfirmDialog.test.tsx
```

Expected: FAIL because `ConfirmDialog` does not exist.

- [ ] **Step 3: Extract effect-safe dialog focus management**

Create `src/components/useDialogFocus.ts`:

```ts
import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export default function useDialogFocus<T extends HTMLElement>(
  canDismiss: boolean,
  onDismiss: () => void,
): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  const canDismissRef = useRef(canDismiss);
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    canDismissRef.current = canDismiss;
  }, [canDismiss]);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (canDismissRef.current) {
          event.preventDefault();
          dismissRef.current();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement as HTMLElement;
      if (event.shiftKey && (active === first || !elements.includes(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !elements.includes(active))) {
        event.preventDefault();
        first?.focus();
      }
    };

    dialog.addEventListener('keydown', handleKeyDown);
    return () => {
      dialog.removeEventListener('keydown', handleKeyDown);
      previous?.focus();
    };
  }, []);

  return dialogRef;
}
```

- [ ] **Step 4: Implement `ConfirmDialog`**

Create `src/components/ConfirmDialog.tsx`:

```tsx
import ActionButton from './ActionButton';
import useDialogFocus from './useDialogFocus';

export interface ConfirmDialogProps {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(!busy, onCancel);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        tabIndex={-1}
        aria-labelledby="teardown-dialog-title"
        aria-describedby="teardown-dialog-description"
        className="w-full max-w-lg rounded-2xl border border-rose-100 bg-white p-6 shadow-2xl outline-none sm:p-7"
      >
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-rose-700">
          Destructive action
        </p>
        <h2 id="teardown-dialog-title" className="mt-2 text-2xl font-semibold tracking-tight">
          Teardown PostgreSQL?
        </h2>
        <p id="teardown-dialog-description" className="mt-3 text-sm leading-6 text-slate-600">
          The shared PostgreSQL service and its logical databases will be removed. This action
          cannot be undone from this manager.
        </p>
        {busy && (
          <p role="status" aria-live="polite" className="mt-4 text-sm font-medium text-rose-700">
            Starting teardown…
          </p>
        )}
        <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <ActionButton tone="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </ActionButton>
          <ActionButton tone="danger" disabled={busy} onClick={onConfirm}>
            Confirm teardown
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Require dashboard confirmation before teardown**

Add state:

```ts
const [confirmingTeardown, setConfirmingTeardown] = useState(false);
const [teardownSubmitted, setTeardownSubmitted] = useState(false);
```

The danger action opens the dialog:

```tsx
<ActionButton
  tone="danger"
  disabled={busy}
  onClick={() => {
    setTeardownSubmitted(false);
    setConfirmingTeardown(true);
  }}
>
  Teardown PostgreSQL
</ActionButton>
```

Render beside the selected status panel:

```tsx
{
  confirmingTeardown && (
    <ConfirmDialog
      busy={teardownSubmitted}
      onCancel={() => {
        if (!teardownSubmitted) setConfirmingTeardown(false);
      }}
      onConfirm={() => {
        if (teardownSubmitted) return;
        setTeardownSubmitted(true);
        onTeardown();
        setConfirmingTeardown(false);
      }}
    />
  );
}
```

Update dashboard tests: clicking `Teardown PostgreSQL` must make the dialog
visible without calling `onTeardown`; `Confirm teardown` calls once; Cancel and
Escape call it zero times.

- [ ] **Step 6: Run focused checks and commit**

```bash
npx vitest run src/components/ConfirmDialog.test.tsx src/components/ManagerDashboard.test.tsx
npx eslint src/components/useDialogFocus.ts src/components/ConfirmDialog.tsx src/components/ConfirmDialog.test.tsx src/components/ManagerDashboard.tsx src/components/ManagerDashboard.test.tsx
git add src/components/useDialogFocus.ts src/components/ConfirmDialog.tsx src/components/ConfirmDialog.test.tsx src/components/ManagerDashboard.tsx src/components/ManagerDashboard.test.tsx
git commit -m "feat: confirm destructive PostgreSQL teardown"
```

Expected: focused tests PASS and ESLint exits zero.

---

### Task 4: Cohesive Permission and Connection Experience

**Files:**

- Modify: `postgres-interface/src/components/PermissionDialog.tsx:1-124`
- Modify: `postgres-interface/src/components/PermissionDialog.test.tsx:1-150`
- Modify: `postgres-interface/src/components/ConnectionRequest.tsx:126-146`
- Modify: `postgres-interface/src/components/ConnectionRequest.test.tsx:1-143`

**Interfaces:**

- Consumes: `ManagerShell`, `StatusPanel`, `ActionButton`, and `useDialogFocus`.
- Produces: shared-shell connection progress and a restyled permission dialog with unchanged decision semantics.

- [ ] **Step 1: Add failing presentation tests**

Add to `PermissionDialog.test.tsx`:

```tsx
it('wraps a long caller identity inside the dialog', () => {
  renderDialog({ callerId: `manager-${'a'.repeat(160)}` });
  expect(screen.getByTestId('calling-manager-id')).toHaveClass('break-all');
});
```

Import `screen` in `ConnectionRequest.test.tsx` and add:

```tsx
it('presents preparation in the PostgreSQL manager shell', () => {
  const wire = { close: vi.fn() } as unknown as Wire;
  const caller = {
    getResource: vi.fn().mockReturnValue(new Promise(() => undefined)),
  } as unknown as RPCCaller;

  render(<ConnectionRequest {...baseProps(caller, wire)} />);
  expect(screen.getByRole('heading', { name: 'PostgreSQL manager' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Preparing PostgreSQL connection');
});
```

- [ ] **Step 2: Run the tests and verify the presentation failures**

```bash
npx vitest run src/components/PermissionDialog.test.tsx src/components/ConnectionRequest.test.tsx
```

Expected: FAIL because caller wrapping and the connection shell are absent.

- [ ] **Step 3: Migrate `PermissionDialog` to shared behavior and actions**

Remove its local focus selector, refs, synchronization effects, and keyboard
effect. Import `ActionButton` and `useDialogFocus`, then use:

```ts
const dialogRef = useDialogFocus<HTMLDivElement>(!busy, onCancel);
```

Retain `remember`, all ARIA attributes, exact disclosure copy, busy status, and
callback values. Render caller identity as:

```tsx
<span
  data-testid="calling-manager-id"
  className="mt-2 block break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800"
>
  {callerId}
</span>
```

Use the confirmation dialog's backdrop/panel spacing. Use secondary
`ActionButton` for Cancel and primary `ActionButton` for Allow. Give the
checkbox `h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600`.

- [ ] **Step 4: Wrap connection progress and permission prompting**

Replace the bare status return with:

```tsx
const progress = (
  <ManagerShell badge={{ label: 'Connecting', tone: 'progress' }}>
    <StatusPanel
      tone="progress"
      eyebrow="Logical database request"
      title={busy ? 'Creating PostgreSQL connection' : 'Preparing PostgreSQL connection'}
      role="status"
    >
      The manager is validating the installation and preparing isolated database credentials.
    </StatusPanel>
  </ManagerShell>
);

if (prompt) {
  return (
    <>
      {progress}
      <PermissionDialog
        callerId={callingManagerId ?? ''}
        busy={busy}
        onAllow={(remember) => {
          pendingRef.current?.({ allowed: true, remember });
          pendingRef.current = null;
          setPrompt(false);
          setBusy(true);
        }}
        onCancel={() => {
          pendingRef.current?.({ allowed: false, remember: false });
          pendingRef.current = null;
          setPrompt(false);
        }}
      />
    </>
  );
}
return progress;
```

- [ ] **Step 5: Run focused checks and commit**

```bash
npx vitest run src/components/PermissionDialog.test.tsx src/components/ConnectionRequest.test.tsx
npx eslint src/components/PermissionDialog.tsx src/components/PermissionDialog.test.tsx src/components/ConnectionRequest.tsx src/components/ConnectionRequest.test.tsx
git add src/components/PermissionDialog.tsx src/components/PermissionDialog.test.tsx src/components/ConnectionRequest.tsx src/components/ConnectionRequest.test.tsx
git commit -m "feat: unify PostgreSQL connection experience"
```

Expected: existing permission and wire tests plus new presentation tests PASS;
ESLint exits zero.

---

### Task 5: Loading, Fatal Failure, and Global Surface Polish

**Files:**

- Modify: `postgres-interface/src/App.tsx`
- Modify: `postgres-interface/src/App.test.tsx`
- Modify: `postgres-interface/src/index.css:1-33`
- Modify: `postgres-interface/src/App.css:1-3`

**Interfaces:**

- Consumes: `ManagerShell`, `StatusPanel`, `ActionButton`, and the reliability plan's `requestRefresh` behavior.
- Produces: shared-shell loading and fatal failure views plus the final global surface.

- [ ] **Step 1: Add failing loading and fatal-shell tests**

Add to `App.test.tsx`:

```tsx
it('renders initial loading inside the manager shell', () => {
  const current = appClient({
    getManager: vi.fn().mockReturnValue(new Promise(() => undefined)),
  });

  render(<App createClient={() => current} />);
  expect(screen.getByRole('heading', { name: 'PostgreSQL manager' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Loading manager state');
});

it('renders fatal storage failure once in the manager shell', async () => {
  const current = appClient({
    databaseQuery: vi.fn().mockResolvedValue({
      results: [{ statement: 0, status: 'ERR', time: '1ms', result: 'private' }],
    }),
  });

  render(<App createClient={() => current} />);
  expect(
    await screen.findByRole('heading', {
      name: 'Manager storage is unavailable',
    }),
  ).toBeVisible();
  expect(screen.getAllByText('Unable to initialize PostgreSQL manager storage')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(screen.queryByText('private')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the App tests and verify shell expectations fail**

```bash
npx vitest run src/App.test.tsx -t "manager shell|fatal storage"
```

Expected: FAIL because loading and fatal views are bare elements.

- [ ] **Step 3: Compose loading and fatal views from shared primitives**

Select the reliability plan's current presentation and replace the early
returns with:

```tsx
if (!current) {
  return (
    <ManagerShell badge={{ label: 'Loading', tone: 'progress' }}>
      <StatusPanel
        tone="progress"
        eyebrow="Manager startup"
        title="Loading manager state"
        role="status"
      >
        Checking PostgreSQL installation and recovery state.
      </StatusPanel>
    </ManagerShell>
  );
}

if (view.kind === 'error') {
  return (
    <ManagerShell badge={{ label: 'Unavailable', tone: 'danger' }}>
      <StatusPanel
        tone="danger"
        eyebrow="Manager startup"
        title="Manager storage is unavailable"
        role="alert"
        actions={
          <ActionButton tone="secondary" onClick={requestRefresh}>
            Retry
          </ActionButton>
        }
      >
        {view.message}
      </StatusPanel>
    </ManagerShell>
  );
}
```

Import the three components. `requestRefresh` must clear the current
presentation and increment the retry key, so loading appears immediately while
the same client reboots.

- [ ] **Step 4: Tighten global CSS without duplicating component focus styles**

Keep `@import "tailwindcss";` first and replace the remaining `index.css` base
rules with:

```css
@import 'tailwindcss';

:root {
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
  color: #0f172a;
  background: #f8fafc;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

* {
  box-sizing: border-box;
}

html {
  min-width: 320px;
  min-height: 100%;
  background: #f8fafc;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
}

button,
input {
  font: inherit;
}
```

Keep `App.css` exactly:

```css
#root {
  min-height: 100vh;
}
```

Remove the old global focus rule because buttons and styled controls now own
their focus treatment.

- [ ] **Step 5: Run the complete automated checks**

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all non-opt-in tests PASS, ESLint has zero errors/warnings, and the
production build succeeds.

- [ ] **Step 6: Perform the responsive and interaction review**

Run:

```bash
npm run dev -- --host 0.0.0.0
```

Inspect at 320 pixels and a desktop width. Verify:

- No horizontal page overflow with long resource or caller IDs.
- Header and actions stack at narrow width and align at desktop width.
- Loading, install, installing, ready, recovery, teardown-failed, and fatal
  states have distinct text and tone.
- Keyboard focus is always visible.
- Both dialogs trap focus; cancellation restores focus when the trigger remains.
- Teardown cannot begin before confirmation.
- No credentials or raw failures appear.

Stop the development server after inspection.

- [ ] **Step 7: Commit final surface polish**

```bash
git add src/App.tsx src/App.test.tsx src/index.css src/App.css
git commit -m "feat: complete PostgreSQL operational console"
```

---

### Task 6: Final Console Verification

**Files:**

- Verify only; modify files only to correct a failure caused by Tasks 1-5.

**Interfaces:**

- Consumes: all operational-console deliverables.
- Produces: a review-ready console branch.

- [ ] **Step 1: Verify repository state and commit sequence**

From the repository root:

```bash
git status --short
git log --oneline --decorate -8
```

Expected: no uncommitted source changes and scoped commits for primitives,
lifecycle states, teardown confirmation, connection experience, and final
surface polish.

- [ ] **Step 2: Re-run release checks from `postgres-interface/`**

```bash
npm test
npm run lint
npm run build
```

Expected: all non-opt-in tests PASS, ESLint exits zero, and Vite emits the
production bundle.

- [ ] **Step 3: Report evidence without creating an empty commit**

Report test totals, skipped opt-in tests, lint outcome, build outcome, manual
viewport/focus results, and the final commit list to the reviewer. If any
verification correction was necessary, commit only the affected files with a
message that names the corrected behavior.
