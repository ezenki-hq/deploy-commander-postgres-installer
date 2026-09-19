# AGENTS.md

## Current lifecycle contract

Components consume run-backed lifecycle state supplied by `App.tsx`. They must
not add manager-database state, private journals, or `PrimaryState` recovery.
Connection requests may obtain approval, install automatically, and provision;
all durable recovery data belongs in validated run notes/configuration and
Deploy Commander connection records.

## Scope

This file applies to all code under:

```text
postgres-interface/src/components
```

This folder contains React components that initiate PostgreSQL installer actions through the Deploy Commander installer interface.

## Purpose

Components in this folder are responsible for presenting installer controls and translating user actions into Deploy Commander runner calls.

The current components are:

- `Install.tsx`
- `Teardown.tsx`

These components should remain focused on installer actions and related UI behavior. Application-wide run tracking, RPC initialization, and top-level screen selection belong in `src/App.tsx`.

## Technology

- React
- TypeScript
- `@ezenki/deploy-commander-installer-interface`
- Deploy Commander runner actions

## Component Responsibilities

### `Install.tsx`

`Install.tsx` starts the PostgreSQL installation run.

The current installation action:

- Uses the action name `create`.
- Uses the runner image `ezenki/deploy-commander-runner:latest`.
- Declares a PostgreSQL service.
- Uses the `postgres:15` image.
- Configures PostgreSQL environment variables.
- Declares a Deploy Commander PostgreSQL resource.
- Creates the `postgres-data` volume.

The component receives an `RPCCaller` through props and must use that caller rather than creating its own wire or RPC client.

### `Teardown.tsx`

`Teardown.tsx` starts the PostgreSQL teardown run.

The current teardown action:

- Uses the action name `teardown`.
- Uses the runner image `ezenki/deploy-commander-runner:latest`.
- Sends teardown metadata through the provided `RPCCaller`.

The component must not independently determine whether teardown is allowed. Top-level installation state belongs in `App.tsx`.

## Deploy Commander Integration

Use the provided `RPCCaller` for all communication with Deploy Commander.

Installer actions are started with:

```ts
wire.start(action, runner, metadata);
```

The arguments are:

- `action`: the runner action to execute.
- `runner`: the runner image.
- `metadata`: the action-specific deployment plan.

Do not bypass the installer interface package with direct HTTP calls.

Do not create a second RPC caller inside a component.

Do not duplicate the wire setup from `App.tsx`.

## Deployment Metadata

The metadata passed to the runner must match the schema supported by the Deploy Commander runner.

The current installation plan uses:

```ts
{
  services: {
    postgres: {
      image: "postgres:15",
      environment: {
        POSTGRES_USER: user,
        POSTGRES_PASSWORD: password
      },
      resources: [
        {
          resource_type: "postgres",
          name: "postgres",
          metadata: {
            user,
            password
          }
        }
      ]
    }
  },
  volumes: [
    "postgres-data"
  ]
}
```

Preserve the distinction between:

- Docker service configuration.
- Deploy Commander resource declarations.
- Resource metadata.
- Persistent volumes.

Do not move resource declarations outside the service plan unless the runner contract is intentionally changed.

## PostgreSQL Resource

The installer creates a resource with:

```text
resource_type: postgres
name: postgres
```

This resource represents the installed PostgreSQL service within Deploy Commander.

Changes to the resource name or resource type may affect:

- Resource discovery.
- Connection ownership.
- Connection creation.
- Connection deletion.
- Other managers that consume the PostgreSQL resource.

Do not rename these values casually.

## Credentials

The current implementation contains hard-coded development credentials. These are not suitable for production behavior.

When credential generation is implemented:

- Generate credentials at install time.
- Use a sufficiently strong random password.
- Do not log passwords.
- Do not render passwords unnecessarily in the UI.
- Store only the metadata required by the Deploy Commander resource and runner flow.
- Keep the PostgreSQL container environment and resource metadata consistent.

Do not commit fixed production credentials.

## Connection Management

This installer will support creating and destroying connections to PostgreSQL.

Connection features should use the Deploy Commander installer RPC interface rather than directly modifying Deploy Commander storage.

A PostgreSQL connection will likely require data such as:

- Host or service name.
- Port.
- Database name.
- Username.
- Password.
- SSL mode or related connection options when applicable.

The exact connection object and ownership rules must follow the installer interface and Deploy Commander APIs in use at implementation time.

Do not invent an alternate connection format when a shared type or RPC method already exists.

Connection creation and deletion UI may be split into additional components when doing so keeps each component focused.

Suggested responsibilities are:

- A component for listing existing PostgreSQL connections.
- A component or form for creating a connection.
- A control for deleting a selected connection.
- Shared local types or helpers only when they are specific to this folder.

Do not add connection-management behavior to `Install.tsx` unless it is part of the installation transaction itself.

## Run Handling

Components may initiate runs, but top-level run status is managed by `App.tsx`.

After calling `wire.start`:

- Handle rejected promises.
- Avoid unhandled promise rejections.
- Do not independently poll for the same run state already tracked by `App.tsx`.
- Do not create conflicting `running` state that duplicates the top-level state.
- Disable repeated actions when necessary to avoid duplicate runs.

The existing `console.log` calls are temporary development behavior. Prefer visible error state for user-facing failures once the UI is expanded.

## Error Handling

Do not silently ignore failures.

For action failures:

- Capture the error.
- Present a useful error message to the user.
- Preserve enough context to identify which action failed.
- Avoid exposing credentials or sensitive connection data.

Do not throw errors from click handlers solely to surface them to React.

## React Conventions

Use function components.

Define explicit prop interfaces.

Use typed values from `@ezenki/deploy-commander-installer-interface` where available.

Keep side effects inside event handlers or React effects as appropriate.

Avoid using `any` when a shared interface or a local type can describe the value.

Do not create state that can be derived directly from props or existing application state.

## File Organization

Keep one primary component per file.

Component filenames should use PascalCase.

When adding connection-related components, use descriptive names such as:

```text
ConnectionList.tsx
CreateConnection.tsx
DeleteConnection.tsx
```

Do not move files outside this folder without explicitly documenting the move and updating imports.

## Styling

The project currently uses Tailwind utilities and global CSS.

Prefer Tailwind classes for component-level styling.

Avoid adding large component-specific style sections to `App.css`.

Keep controls accessible:

- Buttons must have clear labels.
- Form fields must have labels.
- Disabled and loading states must be visible.
- Error messages must be readable.
- Destructive actions must be clearly identified.

## Security

Treat PostgreSQL credentials and connection details as sensitive.

Never:

- Log passwords.
- Place credentials in URLs.
- Store credentials in browser persistence without an explicit design decision.
- Expose secrets in error messages.
- Reuse the current hard-coded development password in production code.

When deleting a connection, confirm that the operation targets the intended Deploy Commander connection and does not destroy the PostgreSQL service itself.

Teardown and connection deletion are separate operations:

- Teardown removes the PostgreSQL installation.
- Connection deletion removes access data or connection records.

Do not conflate them.

## Validation

Before starting an install or connection action, validate required input.

For PostgreSQL connection creation, validate at least:

- Username is present.
- Password is present.
- Database name is present when required.
- Port is valid.
- Referenced resource or manager identifiers are present.
- Duplicate connections are handled according to the intended ownership rules.

Prefer shared validation helpers when multiple components need the same rules.

## Testing Expectations

When tests are added, cover:

- Install action metadata.
- Teardown action invocation.
- Loading and disabled button behavior.
- Runner call failures.
- Connection creation metadata.
- Connection deletion calls.
- Duplicate connection prevention.
- Sensitive values not appearing in rendered errors.

Mock the `RPCCaller` rather than using a real Deploy Commander instance in component tests.

## Build and Quality Checks

After modifying this folder, run the relevant project checks from `postgres-interface`:

```bash
npm run lint
npm run build
```

Also run any component tests once a test command exists.

Resolve TypeScript and ESLint errors rather than suppressing them without justification.

## Agent Guidance

Before implementing a feature:

1. Read `src/App.tsx` to understand run state and RPC setup.
2. Inspect the current installer interface package types and RPC methods.
3. Confirm the runner metadata contract.
4. Reuse shared types and methods instead of recreating them.
5. Keep installation, teardown, and connection management as separate concerns.
6. Preserve existing resource names and ownership assumptions unless the task explicitly changes them.

When a required RPC method or shared type does not exist, clearly identify that dependency rather than implementing an unrelated direct API workaround.
