import { describe, expect, it } from 'vitest';
import {
  connectionLabels,
  generateDatabaseName,
  parseConnectionRequest,
  resolveDatabaseOrigin,
  sameLabels,
} from './postgresConnectionRequest';

const GUIDE_REQUEST_FIXTURES = [
  { action: 'create-connection', labels: { team: 'payments' } },
  {
    action: 'create-connection',
    scope: 'database',
    operation: 'create',
    database: 'orders',
    labels: { environment: 'production' },
  },
  {
    action: 'create-connection',
    scope: 'database',
    operation: 'existing',
    database: 'warehouse',
  },
  { action: 'create-connection', scope: 'full', superuser: false },
  { action: 'create-connection', scope: 'full', superuser: true },
] as const;

describe('parseConnectionRequest', () => {
  it.each(GUIDE_REQUEST_FIXTURES)('accepts the guide request fixture %#', (metadata) => {
    expect(() => parseConnectionRequest(metadata)).not.toThrow();
  });

  it('accepts labels-only metadata for user configuration', () => {
    expect(
      parseConnectionRequest({
        action: 'create-connection',
        labels: { team: 'payments' },
      }),
    ).toEqual({ labels: { team: 'payments' }, access: null });
  });

  it('accepts labels matching object prototype property names', () => {
    const labels = parseConnectionRequest({
      action: 'create-connection',
      labels: { constructor: 'class', ['__proto__']: 'prototype' },
    }).labels;

    expect(labels.constructor).toBe('class');
    expect(labels['__proto__']).toBe('prototype');
    expect(Object.keys(labels)).toEqual(['constructor', '__proto__']);
  });

  it.each([
    {
      action: 'create-connection',
      scope: 'database',
      operation: 'create',
      database: 'orders',
    },
    {
      action: 'create-connection',
      scope: 'database',
      operation: 'existing',
      database: 'warehouse',
    },
    {
      action: 'create-connection',
      scope: 'full',
      superuser: false,
    },
    {
      action: 'create-connection',
      scope: 'full',
      superuser: true,
    },
  ])('accepts complete access metadata %#', (metadata) => {
    expect(parseConnectionRequest(metadata).access).not.toBeNull();
  });

  it.each([
    { action: 'create-connection', scope: 'database', operation: 'create' },
    { action: 'create-connection', scope: 'full' },
    { action: 'create-connection', unknown: true },
    { action: 'create-connection', labels: { 'postgres.access': 'database' } },
    { action: 'create-connection', labels: { ' postgres.database ': 'orders' } },
    {
      action: 'create-connection',
      scope: 'database',
      operation: 'existing',
      database: 'template0',
    },
  ])('rejects malformed or conflicting metadata %#', (metadata) => {
    expect(() => parseConnectionRequest(metadata)).toThrow('Invalid PostgreSQL connection request');
  });

  it.each(['postgres.access', 'postgres.database', 'postgres.database-origin'])('rejects reserved label %s', (key) => {
    expect(() =>
      parseConnectionRequest({
        action: 'create-connection',
        labels: { [key]: 'caller-value' },
      }),
    ).toThrow('Invalid PostgreSQL connection request');
  });
});

describe('connection request helpers', () => {
  it('generates the stable UUID-shaped database form', () => {
    expect(generateDatabaseName((length) => new Uint8Array(length).fill(10))).toBe(
      'db_0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a',
    );
  });

  it('merges caller and reserved labels', () => {
    expect(
      connectionLabels(
        { scope: 'database', operation: 'create', database: 'orders' },
        { team: 'payments' },
        'managed',
      ),
    ).toEqual({
      team: 'payments',
      'postgres.access': 'database',
      'postgres.database': 'orders',
      'postgres.database-origin': 'managed',
    });

    expect(connectionLabels({ scope: 'full', superuser: false }, {}, null)).toEqual({
      'postgres.access': 'full',
    });
  });

  it('resolves explicit and legacy database origins', () => {
    expect(
      resolveDatabaseOrigin(
        { scope: 'database', operation: 'create', database: 'orders' },
        { 'postgres.access': 'database', 'postgres.database': 'orders' },
      ),
    ).toEqual({ origin: 'managed', legacy: true });

    expect(
      resolveDatabaseOrigin(
        { scope: 'database', operation: 'existing', database: 'orders' },
        {
          'postgres.access': 'database',
          'postgres.database': 'orders',
          'postgres.database-origin': 'existing',
        },
      ),
    ).toEqual({ origin: 'existing', legacy: false });
  });

  it.each([
    {
      access: { scope: 'database', operation: 'existing', database: 'orders' } as const,
      labels: {
        'postgres.access': 'database',
        'postgres.database': 'orders',
        'postgres.database-origin': 'invalid',
      },
    },
    {
      access: { scope: 'database', operation: 'create', database: 'orders' } as const,
      labels: { 'postgres.access': 'full', 'postgres.database': 'orders' },
    },
    {
      access: { scope: 'full', superuser: false } as const,
      labels: { 'postgres.access': 'full', 'postgres.database-origin': 'managed' },
    },
    {
      access: { scope: 'database', operation: 'create', database: 'orders' } as const,
      labels: { 'postgres.access': 'database', 'postgres.database': 'other' },
    },
  ])('rejects invalid origin labels %#', ({ access, labels }) => {
    expect(() => resolveDatabaseOrigin(access, labels as Record<string, string>)).toThrow(
      'Invalid PostgreSQL connection labels',
    );
  });

  it('compares complete label maps independent of key order', () => {
    expect(sameLabels({ a: '1', b: '' }, { b: '', a: '1' })).toBe(true);
    expect(sameLabels({ a: '1' }, { a: '2' })).toBe(false);
  });
});
