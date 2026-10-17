import { describe, expect, it } from 'vitest';
import {
  parseCreateRequest,
  parseDeleteRequest,
  parseLinkRequest,
  parseUnlinkRequest,
} from './requests';

describe('parseCreateRequest', () => {
  it('requires a resource and parses a group-created database request', () => {
    expect(
      parseCreateRequest({
        action: 'create-connection',
        resource: 'resource-1',
        scope: 'database',
        operation: 'create',
        database: 'orders',
        labels: {
          custom_deployer_group_id: 'group-1',
          custom_deployer_connection_origin: 'created',
          team: 'payments',
        },
      }),
    ).toEqual({
      action: 'create-connection',
      resourceId: 'resource-1',
      requestedAccess: { scope: 'database', operation: 'create', database: 'orders' },
      labels: {
        custom_deployer_group_id: 'group-1',
        custom_deployer_connection_origin: 'created',
        team: 'payments',
      },
    });
  });

  it('accepts access selection without group labels', () => {
    expect(
      parseCreateRequest({
        action: 'create-connection',
        resource: 'resource-1',
        scope: 'full',
      }),
    ).toEqual({
      action: 'create-connection',
      resourceId: 'resource-1',
      requestedAccess: { scope: 'full', superuser: false },
      labels: {},
    });
  });

  it.each([
    { action: 'create-connection' },
    { action: 'create-connection', resource: ' ' },
    { action: 'create-connection', resource: 'resource-1', labels: { custom_deployer_group_id: 'g1' } },
    {
      action: 'create-connection',
      resource: 'resource-1',
      labels: {
        custom_deployer_group_id: 'g1',
        custom_deployer_connection_origin: 'imported',
      },
    },
    {
      action: 'create-connection',
      resource: 'resource-1',
      labels: { custom_deployer_connection_origin: 'created' },
    },
    {
      action: 'create-connection',
      resource: 'resource-1',
      labels: { 'postgres.access': 'override' },
    },
    { action: 'create-connection', resource: 'resource-1', scope: 'database', operation: 'create' },
  ])('rejects malformed create request %#', (metadata) => {
    expect(() => parseCreateRequest(metadata)).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe('parseLinkRequest', () => {
  it('parses the imported group labels and preserves other requested labels', () => {
    expect(
      parseLinkRequest({
        action: 'link-connection',
        resource: 'resource-1',
        connection: 'connection-1',
        labels: {
          custom_deployer_group_id: 'group-1',
          custom_deployer_connection_origin: 'imported',
          team: 'payments',
        },
      }),
    ).toEqual({
      action: 'link-connection',
      resourceId: 'resource-1',
      connectionId: 'connection-1',
      labels: {
        custom_deployer_group_id: 'group-1',
        custom_deployer_connection_origin: 'imported',
        team: 'payments',
      },
    });
  });

  it.each([
    { action: 'link-connection', resource: 'resource-1', connection: 'connection-1' },
    {
      action: 'link-connection',
      resource: 'resource-1',
      connection: 'connection-1',
      manager: 'untrusted-manager',
      labels: {
        custom_deployer_group_id: 'group-1',
        custom_deployer_connection_origin: 'imported',
      },
    },
    {
      action: 'link-connection',
      resource: 'resource-1',
      connection: 'connection-1',
      labels: {
        custom_deployer_group_id: 'group-1',
        custom_deployer_connection_origin: 'created',
      },
    },
  ])('rejects malformed link request %#', (metadata) => {
    expect(() => parseLinkRequest(metadata)).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe('parseUnlinkRequest', () => {
  it('parses resource, connection, and group', () => {
    expect(
      parseUnlinkRequest({
        action: 'unlink-connection',
        resource: 'resource-1',
        connection: 'connection-1',
        group: 'group-1',
      }),
    ).toEqual({
      action: 'unlink-connection',
      resourceId: 'resource-1',
      connectionId: 'connection-1',
      groupId: 'group-1',
    });
  });

  it.each([
    { action: 'unlink-connection', resource: 'resource-1', connection: 'connection-1' },
    {
      action: 'unlink-connection',
      resource: 'resource-1',
      connection: 'connection-1',
      group: 'group-1',
      manager: 'untrusted-manager',
    },
    { action: 'unlink-connection', resource: ' ', connection: 'connection-1', group: 'group-1' },
  ])('rejects malformed unlink request %#', (metadata) => {
    expect(() => parseUnlinkRequest(metadata)).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe('parseDeleteRequest', () => {
  it('accepts chooser, single ID, and explicit IDs', () => {
    expect(parseDeleteRequest({ action: 'delete-connection' })).toEqual({
      action: 'delete-connection',
      connectionId: null,
    });
    expect(parseDeleteRequest({ action: 'delete-connection', connection: 'connection-1' })).toEqual(
      { action: 'delete-connection', connectionId: 'connection-1' },
    );
    expect(
      parseDeleteRequest({ action: 'delete-connection', connections: ['connection-1'] }),
    ).toEqual({ action: 'delete-connection', connectionIds: ['connection-1'] });
  });

  it.each([
    { action: 'delete-connection', connections: [] },
    { action: 'delete-connection', connections: ['connection-1', ''] },
    { action: 'delete-connection', connections: ['connection-1', 'connection-1'] },
    { action: 'delete-connection', connection: 'connection-1', connections: ['connection-2'] },
  ])('rejects malformed delete request %#', (metadata) => {
    expect(() => parseDeleteRequest(metadata)).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });
});
