# PostgreSQL Action Approval Gate Design

## Status

Proposed design for review. This document supersedes the earlier provisional-dialog fix for action approval behavior. It does not authorize implementation or publication by itself.

## Problem

Create-connection requests can display only **Preparing PostgreSQL connection** without presenting an approval dialog or starting a runner action. Delete-connection requests share the same control flow and can fail in the same way.

Two distinct gaps are present:

1. The request UI is conditional on successful prerequisite discovery. `App` converts a missing or failed `getCallingManager()` response into `initialError`. `ConnectionRequest` and `DeleteConnectionRequest` initialize their approval state only when a nonblank caller ID exists and `initialError` is absent. They still render their progress page while their effect closes the child interface. The result is exactly the reported progress-only screen.
2. Local tests and builds do not establish what code the running Deploy Commander manager serves. The local `dist` artifact contains the provisional approval copy, but publication of that artifact has not been verified.

The current tests mask the first gap because the shared App fixture always returns `caller-manager` from `getCallingManager()`.

## Intent and Success Criteria

Every state-changing PostgreSQL action must cross a visible, explicit user-approval boundary. The UI must never substitute an unlabeled progress screen for that boundary.

The work succeeds when:

- A recognized create-connection or delete-connection request immediately displays a modal action gate.
- The gate remains visible while read-only prerequisite checks run.
- A missing caller identity, malformed request, failed prerequisite check, or recovery condition changes the gate to a blocked state with a sanitized explanation; it never removes the gate or leaves only the progress screen.
- Approval is enabled only when the request has a validated caller identity and complete review context.
- Reject or Cancel is available in preparing, ready, and blocked states and closes the child interface with a normalized response.
- No state-changing RPC, including `start`, `createConnection`, `deleteConnection`, or `databaseQuery` with a mutating statement, occurs before explicit approval.
- One approval can start at most one action.
- Install and teardown retain explicit confirmation before their runner actions.
- The built and published manager can be identified unambiguously, and a real host-level create/delete smoke test proves the published UI is the code under test.

## Constraints

- Calling-manager identity remains authoritative only when supplied by `getCallingManager()`. Metadata must never be accepted as an identity fallback.
- Approval is per request. It is not remembered in local storage, session storage, cookies, manager metadata, or process state.
- Read-only discovery may run while the gate is visible. Mutations may not.
- Existing run-backed lifecycle and connection recovery contracts remain intact.
- Administrator credentials, logical credentials, raw transport failures, and unfiltered metadata must never be rendered or logged.
- The runner image, runner action names, connection schema, resource identity, and wire protocol remain unchanged.
- No new runtime dependency is required.

## Mutation Inventory and Approval Ownership

The approval boundary is defined by user intent, not by individual low-level RPCs. One approved request may perform the mutation sequence required to complete or safely reconcile that request, but no mutation may escape its owning gate.

| User-visible action          | Approval owner                  | Mutations covered by that approval                                                                                                                                                 |
| ---------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install PostgreSQL           | Dashboard install confirmation  | Lifecycle `create` runner start                                                                                                                                                    |
| Teardown PostgreSQL          | Dashboard teardown confirmation | Lifecycle `teardown` runner start and its runner-defined cleanup                                                                                                                   |
| Create PostgreSQL connection | Create-connection action gate   | Optional installation, `create-connection`/compensating `cleanup-connection` runner starts, connection publication performed by the runner, and catalog cleanup needed by recovery |
| Delete PostgreSQL connection | Delete-connection action gate   | `cleanup-connection` runner start, catalog cleanup, and final `deleteConnection` RPC                                                                                               |

Read-only calls such as manager lookup, resource/run discovery, connection enumeration, ownership checks, and catalog listing may occur during `preparing`. Recovery mutations are allowed only after the same request has entered `executing`; merely opening or retrying preparation never authorizes them.

## Root-Cause Model

The observed symptom has one confirmed code path:

```text
host starts create-connection child interface
  -> App recognizes metadata.action
  -> App waits for getCallingManager()
  -> getCallingManager() returns null or rejects
  -> App creates child view with initialError
  -> ConnectionRequest initializes approval = null
  -> component renders Preparing PostgreSQL connection
  -> effect closes the wire without ever rendering a dialog
```

The same path exists for deletion.

There is also an unresolved runtime-boundary question: whether the deployed host is serving the current local `dist`. The implementation must make that question observable rather than relying on assumption.

## Considered Approaches

### 1. Continue patching component initializers

Initialize the existing dialog with additional provisional values and add more conditions for missing callers and errors.

This is the smallest change, but it keeps request validity, workflow execution, wire closure, and modal visibility coupled through nullable component state. The earlier fix followed this approach and missed the `initialError` branch. It is rejected.

### 2. Render a generic App-level confirmation before child workflows

Show a yes/no confirmation as soon as `metadata.action` is recognized, then mount the existing child component.

This guarantees a popup, but it creates two approvals for valid connection requests or forces the generic confirmation to approve a request before database scope, superuser access, owned connection choices, and installation consequences are known. It is rejected.

### 3. Use an explicit action-gate state machine

Represent preparing, ready, blocked, executing, rejected, and completed states explicitly. The gate is created from the recognized action, not from successful prerequisite data. Specialized connection dialogs render through a shared gate frame, while existing workflows continue to request the final decision only after read-only preparation.

This is the recommended approach. It fixes the missing-caller path, prevents invalid states such as “progress with no gate,” preserves detailed approval, and creates a single place to enforce one-shot transitions.

## Architecture

### Action-gate state

Add a pure state module with a discriminated union:

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
```

Allowed transitions are:

```text
preparing -> preparing   (authoritative caller identified)
preparing -> ready
preparing -> blocked
preparing -> closed       (user rejects)
ready     -> executing    (user approves once)
ready     -> closed       (user rejects)
ready     -> blocked      (state becomes invalid before execution)
blocked   -> preparing    (retry read-only preparation)
blocked   -> closed       (user rejects)
executing -> closed       (success or normalized failure closes the child interface)
```

No transition leaves `closed`, and no event other than approval can enter `executing`.

The gate starts in `preparing` with `callerId: null` as soon as `App` recognizes a valid action request. An `identified` event records a nonblank authoritative caller while the remaining read-only checks continue. A `prepared` event carries both the authoritative caller ID and complete review context, so the generic reducer never extracts identity from an unconstrained context type. A missing or rejected caller lookup sends the gate to `blocked`. A `complete` event is the only transition from `executing` to `closed`; ordinary Reject/Cancel events are ignored during execution.

### Shared dialog frame

Create `ActionApprovalDialog` as a presentation-only shell. It owns modal semantics, focus management, caller identity display, status/error presentation, and Reject/Cancel placement. It receives action-specific content and the phase-specific primary action from create/delete dialog components.

The shell displays:

- **Preparing:** action title, `Identifying…` until caller identity is available, then the caller ID, a read-only-check message, disabled primary action, enabled Reject/Cancel.
- **Ready:** complete review context and enabled primary action.
- **Blocked:** sanitized reason, disabled primary action, Retry when the failure is retryable, enabled Reject/Cancel.
- **Executing:** retained review context, busy status, all actions disabled.

Missing caller identity is a blocked request, not an absent request. The message explains that Deploy Commander did not supply an authoritative calling manager and that the action cannot be approved safely.

### App request routing

`App` continues to recognize `create-connection` and `delete-connection` from metadata. It must preserve the distinction between:

- action recognition;
- metadata parsing;
- calling-manager discovery; and
- action execution.

It must not await calling-manager discovery before mounting a recognized child action. Instead it constructs a child request view containing the parsed request when available plus a normalized parsing failure when not. The child request owns the single authoritative `getCallingManager()` lookup for each preparation attempt, allowing its gate to remain visible while that lookup is pending.

`getCallingManager()` rejection and `null` remain security failures. The UI exposes them as blocked approval states; it does not infer an identity from metadata.

### Create-connection orchestration

`ConnectionRequest` creates its gate synchronously from the child request view:

- syntactically valid metadata begins in `preparing` before caller lookup;
- invalid metadata begins in `blocked` without caller or resource discovery.

For a valid request, the component resolves the authoritative caller, records it in the visible gate, and only then starts the existing workflow. The workflow performs read-only installation, lifecycle, catalog, and connection discovery. Its `requestApproval(context)` callback transitions the gate from `preparing` to `ready` and waits for a decision.

Approving transitions to `executing`, resolves the workflow decision once, and permits installation/provisioning runs. Rejecting resolves a pending decision as denied or aborts pending preparation, then closes the child interface with status 499. A blocked request closes with its original normalized status when the user dismisses it.

### Delete-connection orchestration

`DeleteConnectionRequest` follows the same state model. Ownership discovery and candidate enumeration are read-only preparation. The gate becomes ready only when the authoritative caller owns at least one valid target. Approval selects one validated connection ID. Existing pre-cleanup and pre-delete revalidation remains mandatory.

### Install and teardown

Dashboard install and teardown buttons continue to open confirmation dialogs. The confirmation component uses action-specific titles, descriptions, labels, tones, and busy copy. Tests assert that neither callback fires from the first click.

### Wire closure and cancellation

Each child request keeps one `closeOnce` guard and one `AbortController`.

- Reject during preparation aborts discovery and closes once.
- Reject from ready resolves the pending decision as denied; the workflow maps it to the existing normalized cancellation response.
- Blocked dismissal closes with the prerequisite failure status.
- Unmount aborts work but does not send an additional close.
- Execution ignores further approval/rejection input.

### Build identity and publication

Add a non-sensitive build marker such as `postgres-action-approval-gate-v1` to the manager shell as `data-manager-build`. The marker is stable for this feature and must be present in the built JavaScript bundle.

The implementation is not considered deployed until:

1. the complete test, lint, format, and production-build commands pass;
2. the generated `dist` contains the marker and the preparing/blocked dialog copy;
3. an authorized `deploy-commander publish` publishes that exact `dist`; and
4. a host-level smoke test observes the marker and exercises create and delete requests.

Publication is an external state change and requires explicit authorization at execution time.

## Error Handling

The gate presents normalized, non-secret messages:

| Condition                                 | Status | Gate behavior                                    |
| ----------------------------------------- | -----: | ------------------------------------------------ |
| Calling manager absent or lookup rejected |    400 | Blocked; cannot approve; Reject closes           |
| Malformed create metadata                 |    400 | Blocked; cannot approve; Reject closes           |
| Malformed delete metadata                 |    400 | Blocked; cannot approve; Reject closes           |
| Operation already active                  |    409 | Blocked; Retry preparation is available          |
| Requested target absent                   |    404 | Blocked; Retry preparation is available          |
| Recovery required                         |    503 | Blocked; Retry preparation is available          |
| User rejects valid request                |    499 | Close without mutation                           |
| Unexpected failure                        |    500 | Blocked with generic message; raw error withheld |

The two temporary raw `console.log` calls in `App` are removed. Tests and visible sanitized UI provide the debugging evidence instead.

## Testing Strategy

### Pure state tests

- Every allowed transition reaches the expected state.
- Approve is ignored outside `ready`.
- A second approval is ignored after `executing`.
- No event reopens `closed`.

### App integration tests

- A create action with `getCallingManager()` pending shows the preparing gate.
- A create action with a `null` or rejected caller lookup shows the blocked gate, not the progress-only page.
- A delete action has the same pending/null/rejected coverage.
- Malformed metadata shows the appropriate blocked gate without resource or connection discovery.
- Valid fixtures reach the ready dialog with complete metadata.

### Component workflow tests

- No mutation occurs while preparation is pending.
- Reject during preparation closes once and starts no run.
- Approve from ready starts exactly one run.
- Rerenders and run events do not restart preparation or execution.
- Delete approval cannot select a connection outside the prepared owned choices.
- Blocked requests never expose an enabled primary action.

### Dashboard tests

- Install and teardown require a second explicit confirmation action.
- Cancel starts no runner action.
- Double confirmation starts at most one runner action.

### Artifact and host smoke tests

- Production build contains the build marker and approval-gate copy.
- Published create request shows preparing, then ready or blocked.
- Rejecting create starts no run.
- Approving a valid create starts one `create-connection` run.
- Published delete request follows the equivalent behavior.

## Acceptance Scenarios

### Missing caller

1. Host opens a create-connection child interface.
2. Metadata identifies the action.
3. `getCallingManager()` returns `null`.
4. The UI shows **Approve PostgreSQL access?** with a blocked explanation that no authoritative caller was supplied.
5. Approve is unavailable; Reject closes with a normalized 400 response.
6. No runner or database mutation occurs.

### Slow preparation

1. Host opens a valid create request.
2. Resource discovery remains pending.
3. The preparing approval gate remains visible and cancellable.
4. When discovery completes, the same gate transitions to complete review details.
5. Only explicit approval permits execution.

### Valid deletion

1. Host opens a delete request.
2. The gate appears while ownership is checked.
3. Valid owned choices appear in the ready state.
4. Approval triggers cleanup and deletion once.
5. Rejection triggers neither.

### Published artifact

1. The production build is generated.
2. The bundle contains `postgres-action-approval-gate-v1`.
3. That bundle is published with authorization.
4. The running manager root exposes the same marker.
5. Host smoke scenarios pass against the published manager.

## Non-Goals

- Changing Deploy Commander’s calling-manager contract.
- Allowing connection actions without an authoritative caller.
- Remembering or auto-approving decisions.
- Replacing run-backed recovery or resource validation.
- Changing PostgreSQL access semantics, runner plans, or connection formats.
- Building a general application-wide modal framework beyond these action gates.

## Rollback

The UI and state-machine changes can be reverted without changing durable run, resource, or connection data. Publication rollback uses the previously published manager artifact. No migration is required.
