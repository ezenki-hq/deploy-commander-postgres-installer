# Resource Connection Manager Guide

This guide is for authors of a Deploy Commander manager that owns resources and creates or deletes connections for those resources. Custom Deployer uses this manager-owned workflow for its default form's deployment-group connection pool.

For low-level interface startup, authentication, RPC, connection configuration, and authorization details, use the current [Manager Interface Guide](docs/integration/MANAGER_INTERFACE_GUIDE.md) and [Commander Manager Integration Guide](docs/integration/COMMANDER_MANAGER_INTEGRATION_GUIDE.md). For how the runner consumes a connection reference, use the [Deployment Runner Implementation Guide](docs/integration/DEPLOYMENT_RUNNER_IMPLEMENTATION_GUIDE.md).

## Ownership

The manager that owns a resource owns the setup and cleanup semantics for connections attached to that resource. Custom Deployer chooses the resource and starts the owning manager's interface; it does not implement database, registry, or other resource-specific connection setup.

Deploy Commander supplies the trusted identity of the manager that opened the interface. Treat the supplied resource and connection IDs as requests to validate through the scoped manager interface. Do not trust a caller-supplied manager identity or accept a connection attached to an unrelated resource.

## Create request

Custom Deployer opens the manager identified by the selected resource's `manager` field and passes this interface metadata:

```json
{
  "action": "create-connection",
  "resource": "<resource-id>",
  "labels": {
    "custom_deployer_group_id": "<deployment-group-id>"
  }
}
```

`labels` is optional in the generic workflow. When present, it is classification and discovery metadata for the Deploy Commander connection. It is not manager-specific connection configuration. For this request, preserve the supplied group label on the resulting connection so Custom Deployer can recover it after an interrupted save and clean it up when the deployment group is deleted.

The manager should:

1. Validate the request shape and confirm that the resource exists and is owned by the current manager.
2. Run its normal resource-specific setup and validation workflow.
3. Create the Deploy Commander connection through its authorized manager interface, attached to the requested resource and carrying the requested labels.
4. Close the child interface with a successful result containing the authoritative created connection identity and ownership fields.

The successful close result must include a `connection` object with at least `id`, `manager`, `resource`, and `labels`, for example:

```json
{
  "connection": {
    "id": "<connection-id>",
    "manager": "<trusted-current-manager-id>",
    "resource": "<resource-id>",
    "labels": {
      "custom_deployer_group_id": "<deployment-group-id>"
    }
  }
}
```

Custom Deployer verifies the returned identity and then performs a scoped single-connection read before saving the reference. Do not return credentials or other secret connection configuration in the child close result. A failed or cancelled workflow should close with the standard failed interface response; Custom Deployer leaves the group unchanged. If creation succeeded but the group save later conflicts, the group label makes the connection discoverable for recovery.

## Delete request

Deletion is also performed by the manager that owns the attached resource. Custom Deployer passes an array even when deleting one connection:

```json
{
  "action": "delete-connection",
  "connections": ["<connection-id>"]
}
```

The manager should:

1. Validate the request and resolve each connection through the current manager's authorized interface.
2. Confirm that each connection is attached to a resource owned by this manager.
3. Perform resource-specific cleanup required before removing each connection.
4. Delete the Deploy Commander connection and close successfully only after the requested deletion is complete.

If cleanup or deletion fails, return a failed interface response and preserve enough state for a retry. Custom Deployer checks that a requested group-owned connection is no longer visible after the manager closes. Imported connections are only unlinked from the deployment group and are not sent through this deletion workflow.

## Keep Corvo routing separate

Corvo connections carry routing state and use Corvo's dedicated create, update, and delete workflow. Do not handle them as generic group resource connections. Follow the [Corvo Manager Integration Guide](docs/integration/CORVO_MANAGER_INTEGRATION_GUIDE.md) for that contract.

## Runner boundary

For each service that uses a group connection, Custom Deployer sends the runner a connection reference:

```json
{
  "type": "Connection",
  "data": {
    "resource": "<resource-id>",
    "connection": "<connection-id>"
  }
}
```

Custom Deployer resolves configured service-field bindings from the live connection metadata before starting a run. The runner receives the concrete service configuration and the resource/connection reference; it resolves and validates the platform connection descriptor under the runner contract. Do not put connection metadata or secrets in group labels, published form files, or the child-interface close result.
