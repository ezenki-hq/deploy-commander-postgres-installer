import { describe, expect, it } from 'vitest';
import { parseCreateRequest, parseDeleteRequest } from './requests';

describe('parseCreateRequest', () => {
  it.each([
    { action: 'create-connection', labels: { team: 'payments' } },
    { action: 'create-connection', scope: 'database', operation: 'create', database: 'orders' },
    {
      action: 'create-connection',
      scope: 'database',
      operation: 'existing',
      database: 'warehouse',
    },
    { action: 'create-connection', scope: 'full', superuser: false },
    { action: 'create-connection', scope: 'full', superuser: true },
  ])('accepts documented request variant %#', (metadata) => {
    expect(parseCreateRequest(metadata).action).toBe('create-connection');
  });

  it('accepts the published database-create request', () => {
    expect(
      parseCreateRequest({
        action: 'create-connection',
        scope: 'database',
        operation: 'create',
        database: 'orders',
        labels: { team: 'payments' },
      }),
    ).toEqual({
      action: 'create-connection',
      requestedAccess: { scope: 'database', operation: 'create', database: 'orders' },
      labels: { team: 'payments' },
    });
  });

  it('ignores unknown create-request fields', () => {
    expect(
      parseCreateRequest({
        action: 'create-connection',
        scope: 'database',
        operation: 'create',
        database: 'corvo',
        unused: 'ignored',
      }),
    ).toEqual({
      action: 'create-connection',
      requestedAccess: { scope: 'database', operation: 'create', database: 'corvo' },
      labels: {},
    });
  });

  it('ignores access fields unused by the selected scope', () => {
    expect(
      parseCreateRequest({
        action: 'create-connection',
        scope: 'database',
        operation: 'create',
        database: 'corvo',
        superuser: false,
      }),
    ).toEqual({
      action: 'create-connection',
      requestedAccess: { scope: 'database', operation: 'create', database: 'corvo' },
      labels: {},
    });
    expect(
      parseCreateRequest({
        action: 'create-connection',
        scope: 'full',
        superuser: true,
        operation: 'create',
        database: 'ignored',
      }),
    ).toEqual({
      action: 'create-connection',
      requestedAccess: { scope: 'full', superuser: true },
      labels: {},
    });
  });

  it('defaults an omitted full-access superuser flag to false', () => {
    expect(parseCreateRequest({ action: 'create-connection', scope: 'full' })).toEqual({
      action: 'create-connection',
      requestedAccess: { scope: 'full', superuser: false },
      labels: {},
    });
  });

  it.each([
    { action: 'create-connection', scope: 'database', operation: 'create' },
    { action: 'create-connection', labels: { ' postgres.access ': 'full' } },
    { action: 'create-connection', scope: 'database', operation: 'create', database: 'template1' },
  ])('rejects invalid or incomplete metadata %#', (metadata) => {
    let thrown: unknown;
    try {
      parseCreateRequest(metadata);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ status: 400 });
  });

  it.each(['postgres.access', 'postgres.database', 'postgres.database-origin'])(
    'rejects caller override of reserved label %s',
    (key) => {
      expect(() =>
        parseCreateRequest({ action: 'create-connection', labels: { [key]: 'override' } }),
      ).toThrowError(expect.objectContaining({ status: 400 }));
    },
  );
});

describe('parseDeleteRequest', () => {
  it('accepts selection and explicit-ID forms', () => {
    expect(parseDeleteRequest({ action: 'delete-connection' })).toEqual({
      action: 'delete-connection',
      connectionId: null,
    });
    expect(parseDeleteRequest({ action: 'delete-connection', connection: 'connection-1' })).toEqual(
      { action: 'delete-connection', connectionId: 'connection-1' },
    );
  });
});
