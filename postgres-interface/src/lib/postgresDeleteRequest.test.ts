import { describe, expect, it } from 'vitest';
import { parseDeleteConnectionRequest } from './postgresDeleteRequest';

describe('parseDeleteConnectionRequest', () => {
  it('accepts selection mode', () => {
    expect(parseDeleteConnectionRequest({ action: 'delete-connection' })).toEqual({
      connectionId: null,
    });
  });

  it('accepts one supplied connection id', () => {
    expect(
      parseDeleteConnectionRequest({
        action: 'delete-connection',
        connection: 'connection-1',
      }),
    ).toEqual({ connectionId: 'connection-1' });
  });

  it.each([
    null,
    [],
    {},
    { action: 'create-connection' },
    { action: 'delete-connection', connection: '' },
    { action: 'delete-connection', connection: '   ' },
    { action: 'delete-connection', connection: 42 },
    { action: 'delete-connection', manager: 'forged-manager' },
    { action: 'delete-connection', connection: 'connection-1', extra: true },
  ])('rejects malformed request %#', (value) => {
    expect(() => parseDeleteConnectionRequest(value)).toThrow(
      'Invalid PostgreSQL connection deletion request',
    );
  });

  it('requires action to be an own property', () => {
    const value = Object.create({ action: 'delete-connection' }) as Record<string, unknown>;
    expect(() => parseDeleteConnectionRequest(value)).toThrow();
  });
});
