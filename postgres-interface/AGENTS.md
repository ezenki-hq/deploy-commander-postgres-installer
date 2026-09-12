# AGENTS.md

## Current lifecycle contract

Lifecycle truth is derived from the latest validated Deploy Commander run and
resource records. Do not add a manager database, `PrimaryState`, operation
journal, or browser-persisted lifecycle state. Administrator credentials belong
in owner-scoped resource metadata; connection recovery belongs in versioned run
notes/configuration and Deploy Commander connection records. Existing resources
without credentials require teardown and reinstall.

## Scope

This file applies to the entire:

```text
postgres-interface
```

project.

More specific `AGENTS.md` files in child folders override this file for code within those folders.

Current scoped instruction files include:

```text
src/AGENTS.md
src/components/AGENTS.md
```

Read the closest applicable `AGENTS.md` file before modifying code.

## Project Purpose

`postgres-interface` is the React-based installer interface for deploying and managing PostgreSQL through Deploy Commander.

The application currently supports:

* Installing a PostgreSQL service.
* Creating a Deploy Commander PostgreSQL resource.
* Creating persistent PostgreSQL storage.
* Tracking installer runs.
* Tearing down the PostgreSQL installation.

The project will also support:

* Creating connections to the installed PostgreSQL resource.
* Listing existing PostgreSQL connections.
* Destroying PostgreSQL connections.

Installation lifecycle and connection lifecycle are separate concerns and must remain separate in the code.

## Technology Stack

The project uses:

* React 19
* TypeScript
* Vite
* Tailwind CSS
* ESLint
* `@ezenki/deploy-commander-installer-interface`
* Deploy Commander runner metadata

The development container uses Node.js 20.

## Repository Structure

```text
postgres-interface/
├── src/
│   ├── components/
│   │   ├── AGENTS.md
│   │   ├── Install.tsx
│   │   └── Teardown.tsx
│   ├── AGENTS.md
│   ├── App.css
│   ├── App.tsx
│   ├── index.css
│   └── main.tsx
├── eslint.config.js
├── index.html
├── package.json
├── package-lock.json
├── tsconfig.json
├── tsconfig.app.json
├── tsconfig.node.json
└── vite.config.ts
```

Repository-level development helpers may exist outside this folder, including:

```text
docker-compose.yml
restore-node-modules.sh
folder-content-retrieval.py
```

Do not assume those files belong inside the frontend project.

## Architecture

The frontend is embedded in or hosted by the Deploy Commander manager interface.

It communicates with Deploy Commander through:

```text
@ezenki/deploy-commander-installer-interface
```

The installer interface provides the wire protocol, typed RPC caller, events, and related shared types.

The frontend must not directly manage:

* Docker services.
* Docker volumes.
* PostgreSQL users.
* PostgreSQL databases.
* Deploy Commander resources.
* Deploy Commander connections.
* Run persistence.

Those operations must be expressed through supported RPC calls and runner actions.

## Shared Installer Interface

The installer interface dependency is currently linked locally:

```json
"@ezenki/deploy-commander-installer-interface": "file:../../deploy-commander-installer-interface"
```

This means changes to the shared package may affect this project immediately after dependencies are reinstalled or rebuilt.

Before adding a local type, direct API call, or protocol workaround:

1. Inspect the shared installer interface package.
2. Check whether the needed RPC call already exists.
3. Check whether the needed request and response types already exist.
4. Determine whether the shared package should be updated instead.

Do not duplicate shared RPC types inside this project without a strong reason.

Do not bypass the shared package with direct HTTP calls.

## Installer Runner

Installer actions currently use:

```text
ezenki/deploy-commander-runner:latest
```

The current installation action is:

```text
create
```

The current removal action is:

```text
teardown
```

Do not change action names or the runner image casually. They are part of the contract with Deploy Commander and the runner implementation.

When new connection-related actions are introduced, confirm whether they should:

* Use direct installer RPC calls.
* Start runner actions.
* Use a combination of both.

Do not assume connection creation requires a runner action without checking the available RPC interface.

## Current PostgreSQL Installation Plan

The current install component starts a run that declares:

* A service named `postgres`.
* The Docker image `postgres:15`.
* PostgreSQL user and password environment variables.
* A Deploy Commander resource.
* A persistent volume named `postgres-data`.

The current resource identity is:

```text
resource_type: postgres
name: postgres
```

These values may be used by other managers and connection workflows.

Do not rename the service, resource type, resource name, or volume without explicitly considering all dependent behavior.

## Resource Metadata

The PostgreSQL resource currently stores user and password information in resource metadata.

Treat this data as sensitive.

Before expanding metadata, determine whether each value belongs in:

* Service environment variables.
* Resource metadata.
* Connection data.
* Platform data.
* A Deploy Commander-managed secret or object store.

Do not place connection-specific credentials in installation metadata unless they are genuinely part of the installed resource.

Do not expose sensitive metadata in logs or the general UI.

## Connection Management

The next major feature is creating and destroying connections to the PostgreSQL resource.

Connection management must follow Deploy Commander ownership rules.

A connection should only be created when the calling manager is allowed to access:

* A resource owned by that manager, or
* A connection or resource relationship authorized by Deploy Commander.

Use supported RPC calls to retrieve the calling manager identity and available resources.

Do not accept an arbitrary manager identifier from a user-editable input as proof of identity.

Do not enforce ownership only in the browser. The frontend may guide the user, but the Deploy Commander API must enforce authorization.

## Connection Data

A PostgreSQL connection may require values such as:

```text
host
port
database
username
password
ssl mode
```

The exact schema must come from the shared installer interface and Deploy Commander connection contract.

Do not invent an incompatible frontend-only format.

Keep a clear distinction between:

* The PostgreSQL administrator credentials used to initialize the service.
* A database user created for another manager.
* A Deploy Commander connection record.
* Public connection information.
* Private connection information.
* Platform-specific connection data.

Sensitive values must not be stored in local storage or session storage without an explicit design decision.

## Installation State

The current application infers installation state from recent runs.

That is acceptable only while the relevant actions are limited to installation and teardown.

Once connection actions are added, the most recent run may be a connection action and must not be treated as proof that PostgreSQL is installed or removed.

Before adding connection action runs, update the installation-state design so it relies on a reliable signal, such as:

* The existence of the PostgreSQL resource.
* A dedicated installer status RPC.
* Filtering runs only for installation lifecycle actions.
* Another authoritative state supported by Deploy Commander.

Do not allow connection actions to cause the interface to display the install screen incorrectly.

## Run State

The application tracks active runs through interface events.

Keep these concerns separate:

* Whether PostgreSQL is installed.
* Whether an installer action is currently running.
* Which action is running.
* Whether a connection operation is running.
* Whether an RPC request is loading.
* Whether an operation failed.

Avoid a single ambiguous boolean when richer state is required.

Prefer explicit state models as the feature set expands.

## UI Responsibilities

The UI should make these operations clear:

* Install PostgreSQL.
* View installation status.
* Create a connection.
* View existing connections.
* Delete a connection.
* Teardown PostgreSQL.

Destructive actions must be clearly identified.

Deleting a connection must not be presented as equivalent to tearing down PostgreSQL.

The user should understand whether an action affects:

* A single connection.
* A PostgreSQL database user.
* The PostgreSQL resource.
* The entire PostgreSQL service and volume.

## React Conventions

Use function components and hooks.

Use explicit prop types.

Prefer shared exported types from the installer interface package.

Avoid `any`.

Use `unknown` for untrusted external values and narrow them before use.

Keep application-wide coordination in `App.tsx` or app-level hooks.

Keep feature-specific state close to the feature component.

Do not recreate the RPC caller during each render.

Do not duplicate run event subscriptions across multiple components without a deliberate event architecture.

Because React `StrictMode` is enabled, development effects must tolerate repeated execution.

## File Organization

Use the existing structure until additional complexity justifies expansion.

Reasonable future folders may include:

```text
src/hooks
src/lib
src/types
src/features
```

Do not create these folders merely for one small function.

A `features/connections` folder may become appropriate once connection management includes multiple components, hooks, validation rules, and types.

If moving files or responsibilities between folders:

* State the move explicitly.
* Update imports.
* Update applicable `AGENTS.md` files.
* Avoid silently changing the project structure.

## Styling

Tailwind CSS is available through the Vite plugin.

Prefer Tailwind utilities for component-level styling.

Global styles belong in:

```text
src/index.css
src/App.css
```

The existing styles include Vite starter content and may be simplified when redesigning the application.

Avoid unrelated styling rewrites during RPC or runner integration work.

Keep the UI usable at the minimum supported viewport width.

## Accessibility

Use semantic HTML.

All interactive elements must be keyboard accessible.

Requirements include:

* Clear button labels.
* Associated labels for form inputs.
* Visible focus states.
* Proper disabled states.
* Readable error messages.
* Clear loading and running states.
* Explicit destructive-action wording.
* No reliance on color alone for status.

Use accessible status messaging for asynchronous operations where practical.

## Security

PostgreSQL credentials and connection data are sensitive.

Never:

* Log passwords.
* Include passwords in URLs.
* Render passwords in general status messages.
* Store secrets in browser persistence by default.
* Include credentials in exception text.
* Commit fixed production credentials.
* Trust browser state as authorization.
* Expose private connection data to managers that do not own it.

The current hard-coded user and password are development placeholders and must not remain as production behavior.

Generate strong random credentials where appropriate.

Use the correct Deploy Commander storage path for sensitive connection information.

## Error Handling

Handle RPC and runner failures explicitly.

The UI should:

* Exit loading states after failures.
* Present a useful error message.
* Allow retry when safe.
* Identify the failed operation.
* Avoid leaking secrets.
* Avoid duplicate submissions after partial failures.

Do not rely only on `console.log`.

Do not throw from click handlers merely to make failures visible.

Normalize unknown errors before rendering them.

## Validation

Validate user input before starting connection operations.

Likely validation includes:

* Required database name.
* Required username.
* Valid port.
* Valid resource identifier.
* Valid manager ownership context.
* Password requirements.
* Duplicate connection checks.
* Safe PostgreSQL identifier rules.

Client-side validation improves usability but does not replace API-side validation.

Do not construct SQL directly in the frontend.

## Dependency Management

Use npm.

The project includes a committed `package-lock.json`.

Do not delete or regenerate the lockfile as routine cleanup.

When changing dependencies:

```bash
npm install <package>
```

Review changes to both:

```text
package.json
package-lock.json
```

The repository includes `restore-node-modules.sh`, which deletes both `node_modules` and the lockfile before reinstalling. Treat that as a recovery helper, not the normal dependency workflow.

Do not edit `package-lock.json` manually.

## Development Environment

The repository-level Docker Compose service runs the frontend using:

```text
node:20
```

It starts Vite on:

```text
0.0.0.0:5173
```

The container joins the external Docker network:

```text
manager
```

The network must already exist.

Do not rename the service, network, working directory, or mounted paths without checking the repository layout and manager integration.

## Commands

Run commands from:

```text
postgres-interface
```

Install dependencies:

```bash
npm install
```

Start development:

```bash
npm run dev
```

Lint:

```bash
npm run lint
```

Build:

```bash
npm run build
```

After code changes, run at least:

```bash
npm run lint
npm run build
```

Do not consider work complete while TypeScript, lint, or build errors remain unresolved.

## Testing

Add tests when logic becomes substantial enough to justify them.

Priority areas include:

* Installer state detection.
* Run event processing.
* Install metadata construction.
* Teardown action invocation.
* Connection listing.
* Connection creation.
* Connection deletion.
* Duplicate connection prevention.
* Ownership-related UI behavior.
* RPC failure handling.
* Sensitive data not appearing in output.

Mock the shared RPC caller for unit and component tests.

Do not require a live Deploy Commander installation for normal frontend tests.

Integration tests may use a real or simulated host interface separately.

## Agent Workflow

Before modifying this project:

1. Read this file.
2. Read the closest child `AGENTS.md`.
3. Inspect the relevant frontend files.
4. Inspect the current shared installer interface package.
5. Confirm the RPC and runner contracts.
6. Identify whether the change affects installation, connection, run, or transport state.
7. Reuse shared types.
8. Avoid direct API or protocol workarounds.
9. Preserve security boundaries.
10. Run lint and build checks.

When a required RPC call or type is missing, identify the missing capability clearly.

Do not silently invent replacement APIs.

Do not silently move files, rename resources, or alter ownership assumptions.
