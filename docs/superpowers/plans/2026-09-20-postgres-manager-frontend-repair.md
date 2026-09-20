# PostgreSQL Manager Frontend Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a polished Tailwind PostgreSQL manager whose root lifecycle refreshes immediately and whose create/delete child actions visibly require approval before any run starts.

**Architecture:** Preserve the clean resource/connection workflows and replace only the frontend composition around them. Tailwind-backed presentation components stay stateless; App owns root projections and child stages, while workflow callbacks bridge modal decisions and run progress.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Tailwind CSS 4, `@tailwindcss/vite`, Vitest 5, Testing Library, Deploy Commander installer interface 0.5.

**Spec:** `docs/superpowers/specs/2026-09-20-postgres-manager-frontend-repair-design.md`

## Global Constraints

- Durable installation state comes only from Deploy Commander resources.
- Durable logical access and database ownership come only from connections and reserved labels.
- Do not add `databaseQuery`, catalog state, recovery state, completed-run authority, or browser approval persistence.
- Install begins directly from the root Install button and never opens a confirmation dialog.
- Create connection, delete connection, and teardown each require an explicit in-app decision before mutation.
- Keep `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md` request and response contracts unchanged.
- Use Tailwind CSS v4 through `@tailwindcss/vite`; do not add a component framework.
- Preserve the existing React/TypeScript initializer scaffold and its build/publish scripts; verify
  the package-provided CLI through `npx deploy-commander` without re-running `init` over this tree.
- Keep `deploy-commander.json` target-neutral. Commander URL and credentials remain user-supplied
  environment or uncommitted `.env` values, and this implementation must not publish.
- Keep one wire, one caller, one event source, and one tracker for the App lifetime; do not wrap the lifetime bridge in React Strict Mode.
- Unknown errors and runner output must never expose SQL, logs, credentials, or raw metadata.

## Review Focus

1. An install run can finish while the resource API still reports not installed briefly; the UI must render the actual refreshed projection and remain retryable rather than inventing installed state.
2. Unmounting with an open create/delete/teardown dialog must resolve the pending decision as rejected and abort active work so no promise or listener is stranded.
3. A preflight `404`, `409`, or malformed-resource failure must render a sanitized child failure state and close with that status instead of leaving a blank view.
4. React rerenders must not invoke a child workflow twice, replace its decision resolver, start two runs, or dispose the shared client early.
5. Teardown cancellation, Escape, and focus restoration must all start zero runs and preserve the installed projection.

---

### Task 1: Tailwind Foundation and Shared Visual Primitives

**Files:**

- Modify: `postgres-interface/package.json`
- Modify: `postgres-interface/package-lock.json`
- Modify: `postgres-interface/vite.config.ts`
- Create: `postgres-interface/src/index.css`
- Delete: `postgres-interface/src/styles.css`
- Modify: `postgres-interface/src/main.tsx`
- Create: `postgres-interface/src/components/ManagerShell.tsx`
- Create: `postgres-interface/src/components/ActionButton.tsx`
- Create: `postgres-interface/src/components/ModalDialog.tsx`
- Create: `postgres-interface/src/components/visualPrimitives.test.tsx`

**Interfaces:**

- Consumes: React children and callbacks; no Deploy Commander state.
- Produces: `ManagerShell`, `ActionButton`, `ModalDialog`, and Tailwind-enabled Vite builds for later tasks.

- [ ] **Step 1: Add failing primitive behavior tests**

Create `visualPrimitives.test.tsx` with concrete assertions:

```tsx
it('renders the Deploy Commander shell and semantic status badge', () => {
  render(<ManagerShell badge={{ label: 'Installed', tone: 'success' }}>content</ManagerShell>);
  expect(screen.getByRole('heading', { name: /postgresql manager/i })).toBeVisible();
  expect(screen.getByText('Installed')).toHaveClass('bg-emerald-50');
});

it('traps focus, rejects on Escape, and restores prior focus', async () => {
  const user = userEvent.setup();
  const reject = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        {open && (
          <ModalDialog
            title="Confirm teardown"
            onCancel={() => {
              reject();
              setOpen(false);
            }}
            actions={
              <>
                <button>Cancel</button>
                <button>Confirm</button>
              </>
            }
          >
            <p>Remove PostgreSQL</p>
          </ModalDialog>
        )}
      </>
    );
  }
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Open' });
  await user.click(opener);
  screen.getByRole('button', { name: 'Cancel' }).focus();
  await user.keyboard('{Shift>}{Tab}{/Shift}');
  expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(reject).toHaveBeenCalledOnce();
  expect(opener).toHaveFocus();
});
```

- [ ] **Step 2: Run the primitive tests RED**

Run:

```bash
npm test -- src/components/visualPrimitives.test.tsx
```

Expected: FAIL because the Tailwind primitives do not exist.

- [ ] **Step 3: Install and configure Tailwind v4**

Run from `postgres-interface`:

```bash
npm install --save-dev tailwindcss@^4 @tailwindcss/vite@^4
```

Update `vite.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
  },
});
```

Create `src/index.css`:

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
}

* {
  box-sizing: border-box;
}
html,
body,
#root {
  min-width: 320px;
  min-height: 100%;
}
body {
  margin: 0;
  min-height: 100vh;
}
button,
input,
select {
  font: inherit;
}
```

Import `./index.css` from `main.tsx` and remove the `styles.css` import and file.

- [ ] **Step 4: Implement the shared primitives**

`ManagerShell` uses a `min-h-screen bg-slate-50 px-4 py-6 text-slate-950` frame, a `max-w-5xl`
content container, Deploy Commander eyebrow text, the PostgreSQL manager heading, and badge tone
classes keyed by `neutral | progress | success | warning | danger`.

`ActionButton` exposes:

```ts
export type ActionTone = 'primary' | 'secondary' | 'danger';
export type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ActionTone;
  busy?: boolean;
};
```

`ModalDialog` exposes:

```ts
export interface ModalDialogProps {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  onCancel: () => void;
  busy?: boolean;
  tone?: 'neutral' | 'danger';
}
```

Use a full-screen slate backdrop, a white responsive card, focusable `tabIndex={-1}` dialog,
initial dialog focus, Tab wrap, Escape cancellation when not busy, and focus restoration on cleanup.

- [ ] **Step 5: Run focused and build verification GREEN**

Run:

```bash
npm test -- src/components/visualPrimitives.test.tsx
npm run build
npm run lint
```

Expected: PASS and the built CSS contains Tailwind output.

- [ ] **Step 6: Commit the Tailwind foundation**

```bash
git add postgres-interface/package.json postgres-interface/package-lock.json \
  postgres-interface/vite.config.ts postgres-interface/src/index.css \
  postgres-interface/src/main.tsx postgres-interface/src/components
git add -u postgres-interface/src/styles.css
git commit -m "feat: add tailwind manager visual foundation"
```

---

### Task 2: Lifecycle Results and Dashboard Projection

**Files:**

- Modify: `postgres-interface/src/workflows/lifecycle.ts`
- Modify: `postgres-interface/src/workflows/lifecycle.test.ts`
- Create: `postgres-interface/src/platform/dashboardProjection.ts`
- Create: `postgres-interface/src/platform/dashboardProjection.test.ts`

**Interfaces:**

- Consumes: `loadInstallationProjection`, `listResourceConnectionSummaries`, existing run tracker.
- Produces: `DashboardProjection`, `loadDashboardProjection(caller, knownInstallation?)`, and
  lifecycle functions that return post-action projections.

- [ ] **Step 1: Write failing projection and lifecycle-result tests**

```ts
it('returns installed state and connection count from current resources and connections', async () => {
  const caller = dashboardCaller({
    projection: installedProjection,
    connections: [connectionA, connectionB],
  });
  await expect(loadDashboardProjection(caller)).resolves.toEqual({
    installation: installedProjection,
    connectionCount: 2,
  });
});

it('uses a lifecycle projection without re-reading installation state', async () => {
  const caller = dashboardCaller({ connections: [connectionA] });
  await expect(loadDashboardProjection(caller, installedProjection)).resolves.toEqual({
    installation: installedProjection,
    connectionCount: 1,
  });
  expect(caller.getResources).not.toHaveBeenCalled();
});

it('returns the refreshed projection after install completes', async () => {
  const refreshed = {
    kind: 'installed',
    resource: postgresResource,
  } satisfies InstallationProjection;
  const deps = lifecycleDeps({
    projection: { kind: 'not-installed' },
    reloadProjection: vi.fn().mockResolvedValue(refreshed),
  });
  await expect(installPostgres(deps)).resolves.toEqual(refreshed);
});

it('returns the unchanged installed projection when teardown is cancelled', async () => {
  const installed = {
    kind: 'installed',
    resource: postgresResource,
  } satisfies InstallationProjection;
  const deps = lifecycleDeps({
    projection: installed,
    requestConfirmation: vi.fn().mockResolvedValue(false),
  });
  await expect(teardownPostgres(deps)).resolves.toEqual(installed);
  expect(deps.runTracker.startAndWait).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run lifecycle/projection tests RED**

```bash
npm test -- src/platform/dashboardProjection.test.ts src/workflows/lifecycle.test.ts
```

Expected: FAIL because the projection helper is missing and lifecycle methods return `void`.

- [ ] **Step 3: Implement one dashboard projection loader**

```ts
export type DashboardProjection = {
  installation: InstallationProjection;
  connectionCount: number;
};

export async function loadDashboardProjection(
  caller: RPCCaller,
  knownInstallation?: InstallationProjection,
): Promise<DashboardProjection> {
  const installation = knownInstallation ?? (await loadInstallationProjection(caller));
  if (installation.kind !== 'installed') return { installation, connectionCount: 0 };
  const connections = await listResourceConnectionSummaries(caller, installation.resource.id);
  return { installation, connectionCount: connections.length };
}
```

Do not catch load errors and rewrite them as `not-installed`; preserve the error for the root alert.

- [ ] **Step 4: Return post-action projections from lifecycle workflows**

Change signatures to:

```ts
export async function installPostgres(deps: LifecycleDeps): Promise<InstallationProjection>;
export async function teardownPostgres(deps: LifecycleDeps): Promise<InstallationProjection>;
```

`installPostgres` returns `await reload(deps)` after the tracked create run. `teardownPostgres`
returns the initial installed projection on cancellation and `await reload(deps)` after a tracked
teardown run.

- [ ] **Step 5: Verify focused and complete tests**

```bash
npm test -- src/platform/dashboardProjection.test.ts src/workflows/lifecycle.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit projection behavior**

```bash
git add postgres-interface/src/platform/dashboardProjection.ts \
  postgres-interface/src/platform/dashboardProjection.test.ts \
  postgres-interface/src/workflows/lifecycle.ts \
  postgres-interface/src/workflows/lifecycle.test.ts
git commit -m "fix: return refreshed postgres lifecycle state"
```

---

### Task 3: Presentational Dashboard and In-App Teardown Dialog

**Files:**

- Modify: `postgres-interface/src/components/Dashboard.tsx`
- Create: `postgres-interface/src/components/Dashboard.test.tsx`
- Create: `postgres-interface/src/components/TeardownDialog.tsx`
- Create: `postgres-interface/src/components/TeardownDialog.test.tsx`
- Modify: `postgres-interface/src/components/ProgressPanel.tsx`

**Interfaces:**

- Consumes: `DashboardProjection`, `RunProgress`, shared visual primitives.
- Produces: stateless `Dashboard` and promise-driven `TeardownDialog` presentation for App.

- [ ] **Step 1: Write failing dashboard transition and confirmation tests**

```tsx
it('renders only Install for a not-installed projection', () => {
  render(
    <Dashboard
      projection={{ installation: { kind: 'not-installed' }, connectionCount: 0 }}
      onInstall={vi.fn()}
      onTeardown={vi.fn()}
      busy={false}
    />,
  );
  expect(screen.getByRole('button', { name: /install postgresql/i })).toBeVisible();
  expect(screen.queryByRole('button', { name: /teardown/i })).not.toBeInTheDocument();
});

it('renders installed state and Teardown from the supplied projection', () => {
  render(
    <Dashboard
      projection={{ installation: { kind: 'installed', resource }, connectionCount: 3 }}
      onInstall={vi.fn()}
      onTeardown={vi.fn()}
      busy={false}
    />,
  );
  expect(screen.getByText(/3 managed connections/i)).toBeVisible();
  expect(screen.getByRole('button', { name: /teardown postgresql/i })).toBeVisible();
});

it('uses an in-app destructive confirmation', async () => {
  const decide = vi.fn();
  render(<TeardownDialog busy={false} onDecision={decide} />);
  expect(screen.getByRole('dialog', { name: /teardown postgresql/i })).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: /cancel/i }));
  expect(decide).toHaveBeenCalledWith(false);
});
```

- [ ] **Step 2: Run component tests RED**

```bash
npm test -- src/components/Dashboard.test.tsx src/components/TeardownDialog.test.tsx
```

Expected: FAIL because Dashboard still fetches its own state and TeardownDialog does not exist.

- [ ] **Step 3: Make Dashboard stateless and Tailwind-styled**

Use this prop contract:

```ts
export interface DashboardProps {
  projection: DashboardProjection;
  onInstall: () => void;
  onTeardown: () => void;
  busy: boolean;
  error?: string | null;
}
```

Render separate not-installed, installed, and conflict cards. Show root errors in an accessible
rose alert while retaining the current projection. Use `ActionButton` for install and teardown.

- [ ] **Step 4: Implement the teardown modal and progress panel styling**

`TeardownDialog` composes `ModalDialog` and exposes:

```ts
export interface TeardownDialogProps {
  busy: boolean;
  onDecision: (confirmed: boolean) => void;
}
```

Copy must explicitly state that teardown removes the PostgreSQL service and every database. Use a
danger action labeled `Confirm teardown` and a secondary Cancel action. Style `ProgressPanel` as an
amber/indigo status card with `role="status"` and `aria-live="polite"`.

- [ ] **Step 5: Verify focused tests and accessibility queries**

```bash
npm test -- src/components/Dashboard.test.tsx src/components/TeardownDialog.test.tsx \
  src/components/visualPrimitives.test.tsx
```

Expected: PASS using role/name queries only for interactive controls.

- [ ] **Step 6: Commit root presentation**

```bash
git add postgres-interface/src/components/Dashboard.tsx \
  postgres-interface/src/components/Dashboard.test.tsx \
  postgres-interface/src/components/TeardownDialog.tsx \
  postgres-interface/src/components/TeardownDialog.test.tsx \
  postgres-interface/src/components/ProgressPanel.tsx
git commit -m "feat: add tailwind postgres lifecycle dashboard"
```

---

### Task 4: Typed Modal Decision Controller

**Files:**

- Create: `postgres-interface/src/app/useDecisionController.ts`
- Create: `postgres-interface/src/app/useDecisionController.test.tsx`
- Modify: `postgres-interface/src/components/ApprovalDialog.tsx`
- Modify: `postgres-interface/src/components/CreateConnectionDialog.tsx`
- Modify: `postgres-interface/src/components/DeleteConnectionDialog.tsx`
- Expand: `postgres-interface/src/components/components.test.tsx`

**Interfaces:**

- Consumes: create/delete approval contexts and decisions; Boolean teardown decisions.
- Produces: one pending modal at a time with guaranteed rejection on replacement or unmount.

- [ ] **Step 1: Write failing decision-controller tests**

```tsx
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

it('rejects a pending decision on unmount', async () => {
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
```

- [ ] **Step 2: Run controller and dialog tests RED**

```bash
npm test -- src/app/useDecisionController.test.tsx src/components/components.test.tsx
```

Expected: FAIL because the controller does not exist and dialogs still use the handwritten modal.

- [ ] **Step 3: Implement typed pending decisions**

Expose:

```ts
export type PendingDecision =
  | { kind: 'create'; context: CreateApprovalContext }
  | { kind: 'delete'; context: DeleteApprovalContext }
  | { kind: 'teardown' };

export interface DecisionController {
  pending: PendingDecision | null;
  requestCreate(context: CreateApprovalContext): Promise<CreateApprovalDecision>;
  requestDelete(context: DeleteApprovalContext): Promise<DeleteApprovalDecision>;
  requestTeardown(): Promise<boolean>;
  decideCreate(decision: CreateApprovalDecision): void;
  decideDelete(decision: DeleteApprovalDecision): void;
  decideTeardown(confirmed: boolean): void;
}
```

Store one discriminated resolver in a ref. Starting another decision rejects the old one according
to its type. Cleanup resolves create/delete as `{ allowed: false }` and teardown as `false`.

- [ ] **Step 4: Rebuild approval dialogs on `ModalDialog`**

Remove the bespoke backdrop/layout from `ApprovalDialog` and compose `ModalDialog` plus
`ActionButton`. Keep proposal fields read-only when `requestedAccess` is present. For labels-only
requests, require a non-empty database name for database scope. Delete approval shows role-only
versus role-and-database consequence in an amber or rose callout.

- [ ] **Step 5: Expand dialog behavior tests**

Add tests for fixed proposal read-only display, labels-only editable access, disabled Approve for
empty database, superuser warning, delete consequence text, Escape rejection, initial focus, Tab
wrap, and focus restoration. Run:

```bash
npm test -- src/app/useDecisionController.test.tsx src/components/components.test.tsx \
  src/components/visualPrimitives.test.tsx
```

Expected: PASS with no act warnings.

- [ ] **Step 6: Commit modal decision behavior**

```bash
git add postgres-interface/src/app/useDecisionController.ts \
  postgres-interface/src/app/useDecisionController.test.tsx \
  postgres-interface/src/components/ApprovalDialog.tsx \
  postgres-interface/src/components/CreateConnectionDialog.tsx \
  postgres-interface/src/components/DeleteConnectionDialog.tsx \
  postgres-interface/src/components/components.test.tsx
git commit -m "feat: centralize postgres interface decisions"
```

---

### Task 5: Root App Lifecycle State Machine

**Files:**

- Create: `postgres-interface/src/app/App.test.tsx`
- Modify: `postgres-interface/src/app/App.tsx`
- Modify: `postgres-interface/src/App.test.tsx`
- Modify: `postgres-interface/src/App.tsx`

**Interfaces:**

- Consumes: `DashboardProjection`, lifecycle projection results, decision controller, tracker.
- Produces: root App mode that refreshes visibly after lifecycle actions and never calls browser confirmation.

- [ ] **Step 1: Write failing root integration tests**

Build `rootClient()` with `getManager`, `getCallingManager`, and `getMetadata` returning
`postgres-manager`, `null`, and `{}`. Inject all four `AppServices`. Add:

```tsx
it('transitions from Install to Teardown after install returns an installed projection', async () => {
  const installed = { kind: 'installed', resource } satisfies InstallationProjection;
  const services = appServices({ install: vi.fn().mockResolvedValue(installed) });
  render(
    <App client={rootClient()} services={services} loadDashboard={notInstalledThen(installed)} />,
  );
  await userEvent.setup().click(await screen.findByRole('button', { name: /install postgresql/i }));
  expect(services.install).toHaveBeenCalledOnce();
  expect(await screen.findByRole('button', { name: /teardown postgresql/i })).toBeVisible();
});

it('opens an in-app teardown dialog and cancellation starts no run', async () => {
  const client = rootClient();
  const services = appServices();
  render(<App client={client} services={services} loadDashboard={installedDashboard} />);
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: /teardown postgresql/i }));
  expect(screen.getByRole('dialog', { name: /teardown postgresql/i })).toBeVisible();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: /cancel/i }));
  expect(client.caller.start).not.toHaveBeenCalled();
});

it('never calls browser confirm', async () => {
  const confirm = vi.spyOn(window, 'confirm');
  render(<App client={rootClient()} services={appServices()} loadDashboard={installedDashboard} />);
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: /teardown postgresql/i }));
  expect(confirm).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run root App tests RED**

```bash
npm test -- src/app/App.test.tsx
```

Expected: FAIL because App ignores lifecycle projection results and calls `window.confirm`.

- [ ] **Step 3: Add injectable dashboard loading and root state**

Extend App props:

```ts
type Props = {
  client?: InterfaceClient;
  services?: AppServices;
  loadDashboard?: typeof loadDashboardProjection;
};
```

Root mode loads one `DashboardProjection`, renders loading/error states inside `ManagerShell`, and
passes the resolved projection to the presentational Dashboard. It owns one lifecycle abort
controller per action and aborts it during cleanup.

- [ ] **Step 4: Wire install and teardown results into root state**

For Install, pass `reloadProjection` backed by `loadInstallationProjection`, await the lifecycle
result, then call `loadDashboardProjection(caller, result)` and commit that dashboard projection.
This consumes the workflow's returned resource state rather than immediately replacing it with a
second resource read. Do not request a modal decision.

For Teardown, pass `requestConfirmation: decisions.requestTeardown`, render `TeardownDialog` while
pending, and convert its returned installation projection through the same dashboard loader.
Do not set starting progress until the workflow's `onProgress` callback fires after confirmation.
Cancellation leaves the installed projection and clears local progress.

- [ ] **Step 5: Preserve root errors without falsifying projection state**

On load or lifecycle failure, keep the last projection, clear busy/progress state, and show a
sanitized alert. A retry button invokes the same root refresh. Delete the old Dashboard effect that
converted errors to `not-installed`.

- [ ] **Step 6: Verify root integration and full component suite**

```bash
npm test -- src/app/App.test.tsx src/components/Dashboard.test.tsx \
  src/components/TeardownDialog.test.tsx
npm test
```

Expected: PASS with the Install-to-Teardown transition observable in the DOM.

- [ ] **Step 7: Commit root lifecycle repair**

```bash
git add postgres-interface/src/app/App.tsx postgres-interface/src/app/App.test.tsx \
  postgres-interface/src/App.tsx postgres-interface/src/App.test.tsx
git commit -m "fix: refresh postgres dashboard after lifecycle runs"
```

---

### Task 6: Child Approval and Failure State Machine

**Files:**

- Modify: `postgres-interface/src/app/App.tsx`
- Modify: `postgres-interface/src/app/App.test.tsx`
- Modify: `postgres-interface/src/components/ProgressPanel.tsx`
- Create: `postgres-interface/src/components/FailurePanel.tsx`

**Interfaces:**

- Consumes: create/delete workflows, typed decision controller, `RunProgress`, normalized errors.
- Produces: visible preparing/approval/progress/failure stages and exact child close responses.

- [ ] **Step 1: Write failing create approval-order tests**

```tsx
it('renders create approval before progress and starts nothing before Approve', async () => {
  const completion = deferred<RPC.CreateConnection>();
  const client = childClient({
    action: 'create-connection',
    scope: 'database',
    operation: 'create',
    database: 'orders',
  });
  const services = appServices({
    createConnection: vi.fn(async (deps) => {
      const decision = await deps.requestApproval(createContext);
      if (!decision.allowed)
        throw new PostgresRequestError(499, 'PostgreSQL connection request was cancelled');
      deps.onProgress?.({ phase: 'starting', runId: null });
      return completion.promise;
    }),
  });
  render(<App client={client} services={services} />);
  expect(
    await screen.findByRole('dialog', { name: /approve postgresql connection/i }),
  ).toBeVisible();
  expect(screen.queryByText(/starting postgresql operation/i)).not.toBeInTheDocument();
  expect(client.caller.start).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole('button', { name: /^approve$/i }));
  expect(await screen.findByText(/starting postgresql operation/i)).toBeVisible();
  completion.resolve(createdConnection);
  await waitFor(() =>
    expect(client.wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: true,
      result: createdConnection,
    }),
  );
});
```

- [ ] **Step 2: Add failing rejection, delete, and failure tests**

```tsx
it('renders delete approval before progress and starts nothing before Reject', async () => {
  const client = childClient({
    action: 'delete-connection',
    connection: 'connection-1',
  });
  const services = appServices({
    deleteConnection: vi.fn(async (deps) => {
      const decision = await deps.requestApproval(deleteContext);
      if (!decision.allowed)
        throw new PostgresRequestError(499, 'PostgreSQL connection deletion was cancelled');
      throw new Error('test must not approve');
    }),
  });
  render(<App client={client} services={services} />);
  expect(
    await screen.findByRole('dialog', { name: /approve postgresql connection deletion/i }),
  ).toBeVisible();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(client.caller.start).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole('button', { name: /^reject$/i }));
  await waitFor(() =>
    expect(client.wire.close).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ status: 499 }) }),
    ),
  );
});

it.each(['create-connection', 'delete-connection'] as const)(
  'rejects %s with 499 and zero starts',
  async (action) => {
    const client = childClient({ action });
    render(<App client={client} services={rejectingServices(action)} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: /^reject$/i }));
    expect(client.caller.start).not.toHaveBeenCalled();
    expect(client.wire.close).toHaveBeenCalledWith({
      manager: 'postgres-manager',
      ok: false,
      error: { message: expect.any(String), status: 499 },
    });
  },
);

it('renders and closes a preflight failure instead of going blank', async () => {
  const client = childClient({ action: 'create-connection' });
  render(
    <App
      client={client}
      services={appServices({
        createConnection: vi
          .fn()
          .mockRejectedValue(new PostgresRequestError(404, 'PostgreSQL is not installed')),
      })}
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('PostgreSQL is not installed');
  expect(client.wire.close).toHaveBeenCalledWith(
    expect.objectContaining({ ok: false, error: expect.objectContaining({ status: 404 }) }),
  );
});
```

Also cover invalid action `400`, delete success `{ connection: id }`, unknown error sanitization,
and unmount disposal/decision rejection.

- [ ] **Step 3: Run child App tests RED**

```bash
npm test -- src/app/App.test.tsx -t "approval|rejects|preflight|invalid|unmount"
```

Expected: FAIL because the current App has no explicit child stage or visible failure panel.

- [ ] **Step 4: Implement the child state machine**

Use the exact `ChildViewState` union from the spec. Set `preparing` before invoking the service.
Wire create and delete `requestApproval` to the corresponding decision-controller methods. Wire
`onProgress` to `progress`. Set `failure` before closing an error response. Keep a `ranChild` guard
and stable service/client references so rerenders cannot start a second workflow.

- [ ] **Step 5: Add the Tailwind failure and child status UI**

`FailurePanel` accepts `{ status: number; message: string }`, renders a rose alert card, and never
renders `details`, runner messages, or metadata. Child mode always renders one of Preparing,
approval dialog, progress, or failure inside `ManagerShell`; it never renders an empty main element.

- [ ] **Step 6: Implement unmount cleanup**

Store the child AbortController in a ref. App cleanup aborts it, rejects any pending modal decision,
disposes the tracker, and disposes the interface client once. Add an idempotent cleanup guard if the
provided client can be disposed through more than one path.

- [ ] **Step 7: Verify child routing and complete suite**

```bash
npm test -- src/app/App.test.tsx src/components/components.test.tsx
npm test
npm run lint
npm run build
```

Expected: PASS with no act warnings, unhandled rejections, duplicate starts, or raw error output.

- [ ] **Step 8: Commit child approval repair**

```bash
git add postgres-interface/src/app/App.tsx postgres-interface/src/app/App.test.tsx \
  postgres-interface/src/components/ProgressPanel.tsx \
  postgres-interface/src/components/FailurePanel.tsx
git commit -m "fix: render postgres child approval before runs"
```

---

### Task 7: Hardening, Contract Verification, and Publish Build

**Files:**

- Modify: `postgres-interface/src/finalHardening.test.ts`
- Modify: `postgres-interface/README.md`
- Verify: `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md`
- Verify: `postgres-interface/deploy-commander.json`
- Verify: all `postgres-interface/src/**/*.test.{ts,tsx}`

**Interfaces:**

- Consumes: completed Tailwind UI and existing public contract.
- Produces: regression guards and a target-neutral, publish-ready React build.

- [ ] **Step 1: Add failing frontend architecture guards**

Extend `finalHardening.test.ts`:

```ts
it('contains no browser alert or confirmation APIs', () => {
  expect(productionSource()).not.toMatch(/window\.(alert|confirm)\s*\(/);
});

it('keeps Tailwind wired through Vite and the application stylesheet', () => {
  const packageJson = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
  const vite = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');
  const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
  expect(packageJson).toContain('@tailwindcss/vite');
  expect(vite).toContain('tailwindcss()');
  expect(css).toContain("@import 'tailwindcss'");
});

it('has App integration coverage for lifecycle transitions and both approvals', () => {
  const appTest = readFileSync(join(process.cwd(), 'src/app/App.test.tsx'), 'utf8');
  expect(appTest).toMatch(/transitions from Install to Teardown/i);
  expect(appTest).toMatch(/create approval before progress/i);
  expect(appTest).toMatch(/delete.*approval/i);
});
```

- [ ] **Step 2: Run hardening RED, then GREEN after the completed tasks**

```bash
npm test -- src/finalHardening.test.ts
```

Expected before preceding tasks: FAIL on browser confirmation and missing Tailwind. Expected now:
PASS.

- [ ] **Step 3: Update manager README behavior**

Document the Tailwind Vite setup, root Install behavior, in-app teardown confirmation, automatic
post-run refresh, child create/delete approval, and verification commands. Do not add internal SQL,
credentials, or obsolete state mechanisms.

- [ ] **Step 4: Verify publishing configuration remains exact**

Confirm `deploy-commander.json` remains:

```json
{
  "name": "postgres",
  "kind": "postgres",
  "description": "Installs PostgreSQL and manages approval-gated database connections",
  "buildDirectory": "dist"
}
```

Do not publish because the Deploy Commander target is supplied by the user later. Verify the local
publish artifact with `npm run build` only. Also verify that the generated-project scripts remain:

```json
{
  "build": "tsc -b && vite build",
  "publish:manager": "deploy-commander publish",
  "deploy": "npm run build && npm run publish:manager"
}
```

Run `npx deploy-commander --help` and require exit `0` with both `init` and `publish` usage shown.
Do not re-run `init`; it refuses non-empty destinations and the existing React project is the source
being repaired.

- [ ] **Step 5: Run complete verification**

From `postgres-interface`:

```bash
npm test
npm run lint
npm run build
npm run format:check
npx deploy-commander --help
```

From repository root:

```bash
git diff --check
rg -n "databaseQuery|getLatestRun|object_hooks|recovery required|PostgresRecovery|window\.(alert|confirm)" \
  postgres-interface/src -g '!*.test.ts' -g '!*.test.tsx'
```

Expected: 0 test failures; lint/build/format exit `0`; `git diff --check` prints nothing; `rg`
returns exit `1` with no matches.

- [ ] **Step 6: Request code review and address findings**

Use `superpowers:requesting-code-review` over the complete repair commit range. Fix every Critical
or Important finding with a failing regression test, rerun Step 5, and record any rejected finding
with concrete code evidence.

- [ ] **Step 7: Commit hardening and documentation**

```bash
git add postgres-interface/src/finalHardening.test.ts postgres-interface/README.md
git commit -m "test: harden postgres manager frontend behavior"
```

- [ ] **Step 8: Confirm local integration**

Use `superpowers:finishing-a-development-branch`. Confirm all repair commits are on the user's
intended local branch and the working tree is clean. If execution used a linked worktree, verify the
commits are present on the target branch before reporting completion.
