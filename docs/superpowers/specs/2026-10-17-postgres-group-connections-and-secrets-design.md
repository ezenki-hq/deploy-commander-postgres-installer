# PostgreSQL Group Connections and Secrets Design

**Date:** 2026-10-17

**Status:** Approved in conversation; written review pending

## Purpose and scope

The unreleased PostgreSQL manager will implement the current Resource Connection Manager Guide for Custom Deployer groups. It will create connections on the requested owned resource, link and unlink existing connections through the resource owner, delete group-created connections through its PostgreSQL cleanup workflow, and return authoritative connection identity without configuration or secrets. It will also store administrator and connection usernames and passwords as Deploy Commander secrets. The PostgreSQL Manager Interface Guide will be updated to describe this contract.

There is no credential migration. The manager has not been released, and existing stored resource or connection records with usernames or passwords in metadata are outside the supported state for this change.

## Contract and ownership

The manager uses `getManager()` and `getCallingManager()` as trusted identities. It does not accept a manager identity in child metadata. Every create, link, or unlink request contains `resource`, which must identify the single exact, nonexternal PostgreSQL resource owned by the current manager. The manager resolves supplied connection IDs through its authorized interface and confirms that each connection is attached to that resource. A connection's `manager` may differ from the current manager or caller; resource ownership is the authorization boundary for explicit link, unlink, and delete requests.

Supported child actions are:

| Action              | Required request fields                                                                            | Successful result                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `create-connection` | `resource`; optional access fields and `labels`                                                    | `{ connection: ConnectionItem }`                                                       |
| `link-connection`   | `resource`, `connection`, `labels` with group ID and `imported` origin                             | `{ connection: ConnectionItem }`                                                       |
| `unlink-connection` | `resource`, `connection`, `group`                                                                  | `{ connection: ConnectionItem }`                                                       |
| `delete-connection` | `connections: string[]` for Custom Deployer; existing single-ID and chooser forms remain supported | `{ connections: string[] }` for arrays; `{ connection: string }` for single-ID/chooser |

Returned connection objects include the authoritative ID, resource, and labels, but no `config`, metadata, secret value, or credential. The create result no longer uses `RPC.CreateConnection` as its child result type. Failed and cancelled actions use the standard failed interface response with a normalized status and nonsecret message.

Create keeps the existing approval dialog and access selection. Delete keeps per-target confirmation and revalidation. Link and unlink apply the user's requested label change after ownership and state validation; they need no additional PostgreSQL setup or confirmation. An explicit delete array can target any connection attached to this manager's PostgreSQL resource, regardless of the connection's `manager`, after every target is validated and approved. The chooser form remains limited to the calling manager's connections. A connection labeled `custom_deployer_connection_origin=imported` is rejected by deletion; it must be unlinked.

## Group labels and identity

`custom_deployer_group_id` determines membership. `custom_deployer_connection_origin` is `created` for a group-created connection and `imported` for a linked existing connection. These labels contain no connection details or secrets. PostgreSQL's `postgres.*` labels remain manager-owned and cannot be supplied by callers. Create requires the group origin to be `created` when a group ID is supplied; link requires `imported`; orphaned or contradictory group label pairs are rejected. Non-group callers may omit both group labels.

New connections receive the requested nonreserved labels and the PostgreSQL access labels. Idempotent create reuse matches the caller, resource, access, and group ID, then verifies the requested labels and secret keys. It never silently adopts a connection from another group. For a group-created connection, the group ID is included in the deterministic PostgreSQL login identity. This permits two groups owned by the same calling manager to request the same database and access without sharing a role or rotating each other's password. Non-group requests retain their existing caller/resource/access identity. A duplicate or incompatible identity within one group is a conflict.

Link accepts a visible connection on the exact resource even when its connection manager differs from the caller. It rejects an existing group assignment to another group or a `created` origin. Repeating the same imported link succeeds. It preserves all unrelated labels. Because label RPCs update one key at a time, link sets `custom_deployer_connection_origin=imported` first and the group ID last, then reads the connection again and verifies both. This ordering prevents a partial link from becoming group-visible without its origin. A failed intermediate call returns a failed response; retry is safe.

Unlink requires the requested group ID and `imported` origin, rejects a `created` connection, removes the group ID first and origin second, and verifies the authoritative connection remains without either label. Unrelated labels, metadata, secrets, and the PostgreSQL role remain intact. Repeating an already completed unlink succeeds when both labels are absent. A partial unlink is retried by clearing the remaining imported origin. Label updates cannot provide a cross-key transaction; the ordering and final read minimize partial-state impact, and errors never claim success before verification.

## Secrets and runner plans

The manager upgrades `@ezenki/deploy-commander-installer-interface` to a version with `getSecretKeys` and secret RPC support. A values-capable runner implementing `values_version: 1`, run secrets, secret references, and create-spec secret copying is a deployment prerequisite. The manager keeps the documented runner image selection; deployment must ensure that image has these capabilities before publishing this manager.

The installation run sends generated administrator `USERNAME` and `PASSWORD` in the run's `secrets` map. Its plan sets `values_version: 1`, refers to `[[secret:run:USERNAME]]` and `[[secret:run:PASSWORD]]` in the PostgreSQL service environment, and lists `secrets: ["USERNAME", "PASSWORD"]` on the published resource spec. Resource metadata contains engine/version and no credential values. The manager verifies the exact resource and both secret keys after the run.

A connection provisioning run similarly sends a generated login's `USERNAME` and `PASSWORD` as run secrets, uses run-secret references in its one-time PostgreSQL service environment, and copies both keys to the newly created connection. Its administrator environment uses `[[secret:resource:RESOURCE_UUID:USERNAME]]` and `[[secret:resource:RESOURCE_UUID:PASSWORD]]`. Connection metadata contains host, port, database, access, and `secret_keys: ["USERNAME", "PASSWORD"]`; it contains neither username nor password. The manager verifies the published connection's identity, labels, metadata declaration, and actual secret keys before closing successfully. Existing exact reuse requires the same checks.

Single and batch cleanup plans use resource secret references for the administrator and `[[secret:connection:CONNECTION_UUID:USERNAME]]` for each role being removed. Cleanup does not need the connection password. The generated database-owner role remains derived from resource and database IDs and is not stored as a credential. Runner plans never put usernames or passwords in metadata, service environment literals, notes, labels, or child results. Post-run reads use `getSecretKeys` to verify names and never attempt to read values.

`USERNAME` is declared alongside `PASSWORD` so consuming deployments may bind either key through Custom Deployer. The manager does not place values in connection metadata. Backend secret deletion on connection or resource removal follows Deploy Commander's object lifecycle; the manager does not fetch values before cleanup.

## Connection creation and deletion

Create validates request shape and resource ownership before showing the approval dialog. Preparation is read-only. After approval it refreshes the exact resource, connection state, and active-run state, computes the PostgreSQL database origin as before, and either returns one compatible existing connection or starts a provisioning run. A group label distinguishes group-created connections from other callers' connections. A missing/mismatched resource, conflicting group assignment, ambiguous compatible connection, or absent secret key fails without returning an unsafe result.

Deletion retains existing managed-database cleanup rules: a full-access or existing-database connection loses only its role; the final connection to a manager-created database also drops that database. Explicit arrays validate all IDs, resource attachment, group origin, and cleanup effects before starting one runner run. Every target is confirmed, then targets and peer effects are refreshed after approval. The run performs cleanup in array order and removes connection records only after cleanup succeeds. The manager verifies all IDs are absent before returning success. If cleanup fails, connection records remain available for a safe retry; PostgreSQL steps already completed are idempotent.

## Components and documentation

- `domain/requests.ts` parses the new action shapes and group labels; `domain/credentials.ts` scopes group-created login identities.
- `platform/resources.ts` and `platform/connections.ts` validate exact ownership, public metadata, and secret-key presence without reading credential values.
- `platform/plans.ts` builds values-versioned installation, provisioning, and cleanup plans with secret references and copy lists.
- `workflows/createConnection.ts` and `workflows/deleteConnection.ts` keep approval, revalidation, and runner orchestration; a focused group-label workflow handles link and unlink.
- `app/App.tsx` routes the four child actions and returns the new identity-only results.
- `docs/integrations/POSTGRES_MANAGER_INTERFACE_GUIDE.md` replaces the legacy secret-bearing examples and documents create, link, unlink, array delete, key declarations, result shapes, and runner prerequisite.

## Verification

Focused tests cover parser validation, exact resource and connection ownership, label preservation and partial-failure retries, cross-group login isolation, secret-free plan serialization and results, secret-copy declarations and key checks, approval boundaries, imported-deletion rejection, and batch cleanup behavior. The full Vitest suite, TypeScript/Vite build, ESLint, and Prettier check must pass. Built output is inspected for credential literals in example payloads and for the expected values-versioned reference markers. No live Deploy Commander or runner integration is available in this repository, so publication must wait for confirmation that the selected runner image implements the documented values contract.
