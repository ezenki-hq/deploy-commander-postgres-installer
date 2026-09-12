# AGENTS.md

## Current lifecycle contract

Use validated lifecycle runs and PostgreSQL resource records as the durable
state. Do not reintroduce manager-database queries, `PrimaryState`, journals, or
boot recovery modules. Connection recovery must use versioned run
notes/configuration and Deploy Commander connection records; a credential-less
existing resource must be torn down and reinstalled.

## Scope

This file applies to all code under:

```text
postgres-interface/src
```

More specific `AGENTS.md` files within child folders override this file for code in those folders.

In particular:

```text
src/components/AGENTS.md
```

contains additional instructions for installer action components.

## Purpose

The `src` folder contains the React frontend for the Deploy Commander PostgreSQL installer.

The interface is responsible for:

* Creating the installer RPC caller.
* Communicating with the Deploy Commander host interface.
* Determining whether PostgreSQL is currently installed.
* Tracking active installer runs.
* Showing installation, teardown, and eventually connection-management controls.
* Translating user actions into supported Deploy Commander RPC calls.

The browser interface does not directly manage Docker, PostgreSQL, resources, or connections. Those operations must go through the Deploy Commander installer interface and runner contracts.

## Technology

The frontend uses:

* React 19
* TypeScript
* Vite
* Tailwind CSS
* `@ezenki/deploy-commander-installer-interface`

The application entry point is:

```text
src/main.tsx
```

The top-level application component is:

```text
src/App.tsx
```

## Current Structure

```text
src/
├── components/
│   ├── Install.tsx
│   └── Teardown.tsx
├── App.css
├── App.tsx
├── index.css
└── main.tsx
```

## Application Architecture

### `main.tsx`

`main.tsx` is the browser entry point.

It:

* Loads global styles.
* Finds the `root` DOM element.
* Creates the React root.
* Renders `App` inside `StrictMode`.

Keep this file small.

Do not place application state, RPC setup, installer logic, or feature-specific behavior in `main.tsx`.

### `App.tsx`

`App.tsx` currently owns application-level concerns:

* Creating the installer wire.
* Creating the typed RPC caller.
* Receiving host interface events.
* Checking recent runs.
* Tracking whether a run is active.
* Determining whether the install or teardown UI should be displayed.
* Displaying initial loading and active-run states.

App-level state and coordination belong here or in app-level hooks extracted from here.

Do not duplicate the wire setup or run tracking logic in child components.

### `components`

The `components` folder contains feature controls that initiate installer actions.

Follow the more specific instructions in:

```text
src/components/AGENTS.md
```

## Installer Interface Integration

Use:

```ts
createWire(...)
```

to connect the frontend to the host interface.

Use:

```ts
RPC.SetupRPCCaller(wire)
```

to create the typed RPC caller.

All Deploy Commander communication must go through the shared installer interface package.

Do not:

* Call Deploy Commander HTTP endpoints directly from the browser.
* Reimplement the wire protocol.
* Create custom `postMessage` handling outside the installer interface package.
* Create multiple independent RPC callers without a concrete need.
* Copy RPC request or response types into this project when they are exported by the shared package.

The current setup includes a placeholder `sendAction` implementation for local development:

```ts
async (_wire: WireSend) => {
  return {
    ok: true,
    result: null
  }
}
```

This behavior should not be mistaken for the production transport contract.

When changing wire setup, inspect the current installer interface package before making assumptions about transport behavior.

## RPC Caller Ownership

The typed RPC caller is created once and stored in a ref:

```ts
const caller = useRef(setupWire(...))
```

This keeps the caller stable across React renders.

Pass the caller or the required RPC capability to child components through props or a deliberately introduced context.

Do not recreate the caller during every render.

Do not put the caller itself into React state unless there is a strong reason.

## Run State

The application currently distinguishes these states:

* Initial loading.
* An installer run is active.
* PostgreSQL is not installed.
* PostgreSQL is installed.

The current screen flow is:

```text
loading
  -> running
  -> install or teardown
```

Keep run state separate from connection-management state.

A PostgreSQL installation may be active while having zero, one, or many Deploy Commander connections. Installation state and connection state are not interchangeable.

## Run Discovery

The current application retrieves the most recent run with:

```ts
caller.current.getRuns(
  undefined,
  undefined,
  undefined,
  undefined,
  1
)
```

The helper:

```ts
checkRuns(...)
```

currently treats the installer as ready for installation when:

* There are no runs.
* The latest run action is `teardown`.

Otherwise it treats PostgreSQL as installed.

When changing this logic, account for:

* Failed installation runs.
* Failed teardown runs.
* Queued or running actions.
* Actions unrelated to installation or teardown.
* Additional future actions such as connection creation and deletion.

Do not assume every latest run determines installation state once connection actions are added.

Connection-related runs must not cause the application to incorrectly switch between the install and teardown screens.

A more explicit installation-state check may be required before connection actions are introduced.

## Event Handling

The wire event callback receives `Events.InterfaceEvent`.

The current code handles:

* `run-update` events.
* Other run events containing a run identifier.

For `run-update` events, terminal status values currently recognized are:

```text
2
3
```

After a terminal update, the app refreshes its run-derived state and clears the running state.

Before changing status handling:

* Inspect the shared installer interface types.
* Confirm the meaning of numeric status values.
* Prefer exported enums or named constants when available.
* Do not introduce undocumented status numbers.

The current code ignores an event when its run ID matches `currentRun.current`. Preserve the intended duplicate-event protection, but verify its behavior before expanding event handling.

## React Hooks

Use hooks according to normal React dependency rules.

Callbacks used by effects or wire handlers should be stable where required.

When modifying `checkRun`, event handling, or wire initialization:

* Check closure behavior carefully.
* Avoid stale state.
* Avoid creating a new wire on every render.
* Include required dependencies in hook dependency arrays.
* Do not suppress hook lint warnings without understanding the cause.

Because `StrictMode` is enabled, development effects may run more than once. Code must tolerate this.

## State Design

Keep state minimal and explicit.

Current state includes:

```ts
first
loading
running
```

These names are functional but not especially descriptive.

When doing substantial work in `App.tsx`, prefer names that describe meaning, such as:

```ts
isInstalled
isLoading
isRunActive
```

Do not rename variables as unrelated cleanup during a narrowly scoped feature unless the change improves the implementation being performed.

Do not store values in state that can be derived safely from existing state or fetched data.

Use refs for mutable values that must survive renders without causing rerenders, such as the stable RPC caller or current run identifier.

## Error Handling

The current top-level code does not expose failures from `checkRun` to the user.

When improving error handling:

* Catch RPC failures.
* Show a useful user-facing error state.
* Allow safe retry where appropriate.
* Avoid leaving the application permanently in `Loading`.
* Do not expose credentials or sensitive metadata.
* Do not rely only on `console.log` for user-visible failures.

Errors should be represented separately from loading and running states.

Do not throw from React event handlers merely to surface an error.

## Connection Management

The planned feature will create and destroy PostgreSQL connections through Deploy Commander.

Connection management must remain distinct from PostgreSQL installation lifecycle.

The application will need to distinguish between:

* Installing the PostgreSQL service.
* Tearing down the PostgreSQL service.
* Listing existing connections.
* Creating a PostgreSQL connection.
* Destroying a PostgreSQL connection.
* Tracking runs associated with connection actions.

Do not use the latest run action alone to determine whether PostgreSQL is installed after connection actions are added.

Before implementing connection features:

1. Inspect the available RPC methods in `@ezenki/deploy-commander-installer-interface`.
2. Confirm the PostgreSQL resource representation.
3. Confirm connection ownership rules.
4. Confirm how the calling manager is identified.
5. Confirm the required connection metadata shape.
6. Confirm whether connection creation is performed directly through RPC or through a runner action.
7. Confirm how connection deletion is represented.

Use shared RPC response types when available.

Do not invent a second connection model inside the frontend.

## Connection Ownership

Connection operations must obey Deploy Commander ownership rules.

A connection should only be created or removed when the calling manager is authorized to act on the relevant PostgreSQL resource.

The UI must not assume that seeing a resource automatically grants access to create or delete connections.

When manager identity is required, retrieve it through the supported installer RPC call rather than accepting an arbitrary manager ID from browser input.

Do not trust user-editable client state as proof of manager ownership.

## Component Boundaries

Keep `App.tsx` focused on application coordination.

Move cohesive UI into components when it becomes substantial, including likely features such as:

```text
components/ConnectionList.tsx
components/CreateConnection.tsx
components/DeleteConnection.tsx
components/InstallerStatus.tsx
components/ErrorState.tsx
```

Do not split very small pieces into separate files solely to increase file count.

State shared across installation and connection views should stay at the application level or move into an app-level hook.

Feature-specific form state should stay near the feature component.

## Hooks and Utilities

As application logic grows, app-level logic may be extracted into folders such as:

```text
src/hooks
src/lib
src/types
```

Only create these folders when there is enough code to justify them.

Examples of appropriate extracted logic include:

* Stable installer wire setup.
* Run-state synchronization.
* Connection metadata construction.
* Error normalization.
* Shared input validation.

Do not create generic utility abstractions for logic used only once unless they meaningfully improve clarity or testability.

If files or responsibilities are moved to new folders, explicitly call out the move and update relevant `AGENTS.md` files.

## Types

Prefer types exported by:

```text
@ezenki/deploy-commander-installer-interface
```

Use explicit local types for application-specific state and form data.

Avoid `any`.

Use `unknown` for untrusted values and narrow them before use.

Do not duplicate types such as:

* RPC responses.
* Run records.
* Connection records.
* Resource records.
* Interface events.

When a shared package type is inadequate, determine whether the shared package should be updated rather than hiding the mismatch with unsafe casting.

## Styling

Global styles are located in:

```text
src/index.css
src/App.css
```

Tailwind directives are currently loaded through `index.css`.

Prefer Tailwind utilities for component-level styling.

Use global CSS for:

* Root layout.
* Shared typography.
* Broad application defaults.
* Styles that cannot reasonably be expressed as local utilities.

The existing CSS contains Vite starter styles. These may be removed or simplified when redesigning the interface, but avoid unrelated styling rewrites during backend integration work.

## Accessibility

All controls must remain keyboard accessible.

Use semantic HTML.

Requirements include:

* Buttons use `<button>`.
* Form fields have associated labels.
* Loading states are communicated clearly.
* Errors are visible and understandable.
* Destructive actions are labeled clearly.
* Disabled actions use actual disabled controls where appropriate.
* Focus indication must remain visible.
* Status changes should be exposed accessibly when practical.

Do not rely only on color to indicate state.

## Security

Treat all PostgreSQL credentials and connection metadata as sensitive.

Never:

* Log passwords.
* Put passwords in URLs.
* Place credentials in browser storage without an explicit design decision.
* Display full credentials in general status screens.
* Include secrets in thrown errors or visible debug messages.
* Hard-code production credentials.
* Trust client-provided ownership identifiers without server-side verification.

The frontend may collect or generate credentials, but authorization and ownership enforcement must occur in Deploy Commander.

## Testing

When tests are introduced, prioritize:

* `checkRuns` behavior.
* Installation state detection.
* Active run event handling.
* Terminal run handling.
* RPC failure states.
* Duplicate event behavior.
* Installation and teardown screen selection.
* Connection list rendering.
* Connection creation flow.
* Connection deletion flow.
* Connection action runs not corrupting installation state.
* Sensitive values not appearing in rendered errors.

Mock the installer interface and RPC caller.

Do not require a live Deploy Commander environment for normal unit tests.

## Development Commands

Run commands from:

```text
postgres-interface
```

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Run lint checks:

```bash
npm run lint
```

Build the production bundle:

```bash
npm run build
```

After modifying code under `src`, run at least:

```bash
npm run lint
npm run build
```

Resolve TypeScript and ESLint failures instead of suppressing them without justification.

## Agent Workflow

Before implementing changes under `src`:

1. Read this file.
2. Read any more specific `AGENTS.md` file in the target folder.
3. Read `App.tsx`.
4. Inspect the relevant component files.
5. Inspect current installer interface types and RPC methods.
6. Identify whether the change affects installation state, run state, or connection state.
7. Avoid direct API workarounds when a shared RPC method should be used.
8. Preserve the stable wire and RPC caller lifecycle.
9. Run lint and build checks after changes.

When the required capability does not exist in the shared installer interface, identify the missing RPC or type clearly. Do not silently bypass the intended architecture.
