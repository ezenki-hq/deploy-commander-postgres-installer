# PostgreSQL Manager Frontend Repair Design

## Purpose

Repair the PostgreSQL manager interface without changing the clean rebuild's backend authority.
The interface must be a polished Tailwind React application, reflect current resource and
connection state after every action, and visibly enforce create/delete approval before any run
starts.

## Evidence and root causes

The current implementation does not meet its frontend acceptance criteria:

1. `package.json` has no Tailwind packages, `vite.config.ts` has no Tailwind plugin, and the UI uses
   a small handwritten stylesheet. The interface was never beautified with Tailwind.
2. `App.tsx` supplies `requestConfirmation: async (message) => window.confirm(message)` to the
   teardown workflow. This bypasses the manager's dialog system.
3. `Dashboard.tsx` owns its projection and loads it in an effect depending only on `caller`.
   `installPostgres` reloads the projection internally, but discards it; after install, App clears
   progress without invalidating Dashboard state. The Install page therefore remains visible.
4. Child App routing was not covered by the App tests required in the clean rebuild plan. The only
   App test checks that a heading renders. The create workflow performs read-only preflight before
   invoking `requestApproval`; any preflight failure closes the child while the UI has no child
   error panel. From the user's perspective, the request simply stops.

Passing unit tests did not disprove these failures because they tested workflow functions and one
dialog in isolation, not the React composition that users interact with.

## Scope

This repair changes only frontend composition, lifecycle return values needed for projection
refresh, and UI-focused tests. It preserves:

- resources as installation authority;
- connections and their reserved labels as logical-access and database-ownership authority;
- mandatory approval for create/delete;
- direct Install-button approval with no second install dialog;
- run-start/run-update plus exact `getRun` tracking for transient progress;
- the public request/result contract in `POSTGRES_MANAGER_INTERFACE_GUIDE.md`;
- the prohibition on `databaseQuery`, catalog state, recovery state, and completed-run authority.

## Approaches considered

### Targeted frontend repair — selected

Keep the clean domain and workflow modules. Replace the weak React composition with explicit root
and child controllers, install Tailwind v4, and build focused presentation components. This has the
smallest blast radius and directly addresses each observed failure.

### Restore the deleted manager UI

The deleted manager contained a polished Tailwind shell and dialogs, but it was coupled to the old
catalog/recovery architecture. Restoring it risks reintroducing exactly the state model that the
clean rebuild removed. Its slate/indigo visual language may be reused, but not its workflow code.

### Introduce a component framework

A library such as shadcn/ui would provide polished primitives but adds configuration and generated
components that are unnecessary for this manager. Tailwind utility classes plus local accessible
primitives are sufficient.

## Visual system

Use Tailwind CSS v4 with `@tailwindcss/vite`. The design follows the earlier Deploy Commander
manager's visual language:

- slate-50 application background and white card surfaces;
- indigo primary actions and progress accents;
- emerald installed/success indicators;
- amber preparation/running indicators;
- rose destructive actions and failure alerts;
- responsive `max-w-5xl` shell with readable content widths;
- rounded cards, subtle borders, restrained shadows, and clear typography.

The UI remains usable at 320px width and does not depend on an external icon or component package.

## React scaffold and publishing

Preserve the existing React/TypeScript/Vite project created for the Deploy Commander installer
interface. The package-provided CLI remains available through `npx deploy-commander`; the project
keeps separate `build`, `publish:manager`, and combined `deploy` scripts so publishing remains a
deliberate operation after a successful build.

`deploy-commander.json` stays target-neutral and contains only the stable manager identity,
description, kind, and `dist` build directory. Commander URL and credentials are supplied later by
the user through the supported environment or adjacent uncommitted `.env`; they are never added to
source control. This repair validates the build and CLI locally but does not publish.

## Component boundaries

### `ManagerShell`

Owns the application frame, product heading, descriptive copy, and status badge. All root and child
views render inside the same shell.

### `ActionButton`

Provides consistent primary, secondary, and danger variants with visible focus, disabled, and busy
states.

### `ModalDialog`

Provides `role="dialog"`, `aria-modal`, accessible title/description, initial focus, Tab containment,
Escape cancellation, and focus restoration. Create approval, delete approval, and teardown
confirmation compose this primitive. It never calls a browser alert or confirm API.

### `Dashboard`

Is presentational. It receives the current projection, connection count, progress/error state, and
callbacks. It never fetches data and never stores a second copy of installation state.

### `RootController`

Owns the root projection and connection summaries. Its `refresh()` function calls
`loadInstallationProjection`, then loads summaries only for an installed resource. It refreshes on
mount and after a completed install or teardown.

### `ChildActionController`

Owns one child request and starts it exactly once. Its visible states are:

```ts
export type ChildViewState =
  | { kind: 'preparing' }
  | { kind: 'create-approval'; context: CreateApprovalContext }
  | { kind: 'delete-approval'; context: DeleteApprovalContext }
  | { kind: 'progress'; progress: RunProgress }
  | { kind: 'failure'; status: number; message: string };
```

The workflow's `requestApproval` callback transitions to the corresponding approval state and
returns a promise. Only the rendered dialog can resolve that promise. A rejection resolves with
`allowed: false`, after which the child closes with `499`; no runner starts. Progress cannot replace
the dialog until approval resolves.

## Root lifecycle flow

### Install

1. Root projection is `not-installed`.
2. User clicks Install PostgreSQL. That click is the authorization; no dialog opens.
3. UI renders local starting/queued/running progress from the run tracker.
4. When the run finishes, the lifecycle workflow reloads the resource projection and returns it;
   the root controller uses that exact projection while loading its connection summaries.
5. The projection becomes `installed`; the same mounted interface immediately renders the installed
   card and Teardown action.

### Teardown

1. User clicks Teardown PostgreSQL.
2. An in-app destructive confirmation dialog explains that the service and all databases will be
   removed.
3. Cancel closes the dialog, returns `false` to the workflow, and starts no run.
4. Confirm closes the dialog, returns `true`, and permits one teardown run.
5. Success returns the refreshed resource projection, and the root controller uses it to return the
   dashboard to the Install view.

`installPostgres` and `teardownPostgres` return their post-action `InstallationProjection`. A
cancelled teardown returns the unchanged installed projection. App consumes that return value;
there is no ignored refresh result.

## Child approval flow

1. App obtains the current manager, calling manager, and metadata.
2. Valid create/delete metadata mounts a `preparing` status while read-only resource and connection
   projection occurs.
3. When the workflow calls `requestApproval`, the appropriate approval dialog replaces preparation.
4. Before Approve, tests require zero credential generation, zero `caller.start`, zero runner start,
   zero mutation, and zero successful close.
5. Reject closes with normalized `499` and zero starts.
6. Approve allows refresh, compatibility checks, credential generation, and the exact tracked run.
7. Progress is rendered from `RunProgress` only after approval.
8. Success closes with the exact create/delete result. Failure renders a sanitized alert and closes
   with the normalized failure response.

An absent PostgreSQL resource remains a `404`; it does not trigger installation. Unlike the current
blank view, the child renders the normalized failure state while closing, and the App test proves
that behavior.

## Error and cancellation behavior

- Root projection load failures render an error alert; they are never converted into
  `not-installed`.
- Root lifecycle failure preserves the last known projection and re-enables its action.
- A pending modal is resolved as rejected during unmount so no workflow promise is stranded.
- Unknown child errors expose only `PostgreSQL manager operation failed` with status `500`.
- Approval and teardown dialogs disable actions while their decision is being consumed.
- All AbortControllers created by App are aborted on unmount; the tracker and client are disposed
  exactly once.

## Testing strategy

Component tests cover Tailwind shell/status rendering, focus management, Escape, Tab wrapping,
disabled approval, editable labels-only access, fixed proposals, and teardown consequence copy.

App integration tests use a fake `InterfaceClient` and injected `AppServices` to cover:

- root not-installed rendering;
- Install click starting directly without a modal;
- install completion changing the visible action to Teardown;
- teardown opening an in-app modal;
- teardown Cancel starting no run;
- create child approval appearing before progress or start;
- create rejection closing with `499` and zero starts;
- delete approval and result closure;
- invalid metadata and preflight failure rendering/closing safely;
- unmount resolving decisions, aborting work, and disposing exactly once.

Lifecycle tests assert returned projections rather than merely asserting that a reload callback was
called. Final hardening asserts no `window.alert`, `window.confirm`, or forbidden architecture symbol
exists in production source.

## Acceptance criteria

- Tailwind v4 is installed, configured through Vite, imported once, and used by every visible
  component.
- No production source calls `window.alert` or `window.confirm`.
- Install completion transitions from Install to Teardown without page reload.
- Teardown uses an accessible in-app confirmation and Cancel starts no run.
- Valid create and delete child actions always display their approval dialog before progress or a
  run start.
- Child failures never leave a blank manager view.
- The state model remains resource/connection-only and the public manager interface contract stays
  compatible.
- The React scaffold, `npx deploy-commander` CLI, publish scripts, and target-neutral
  `deploy-commander.json` remain ready for the user-supplied Deploy Commander target.
- Full test, lint, build, format, and forbidden-symbol checks pass from a clean working tree.
