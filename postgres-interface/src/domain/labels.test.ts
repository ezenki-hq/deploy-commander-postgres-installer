import { it, expect } from 'vitest';
import { connectionLabels, databaseOrigin, deletionEffect, parseConnectionLabels } from './labels';

it('adds all database authority labels without allowing caller override', () => {
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
});

it('propagates managed origin from a current peer', () => {
  expect(
    databaseOrigin('existing', 'orders', [
      { access: 'database', database: 'orders', origin: 'managed' },
    ]),
  ).toBe('managed');
});

it('drops only the final managed database connection', () => {
  const target = {
    id: 'c1',
    access: 'database' as const,
    database: 'orders',
    origin: 'managed' as const,
  };
  expect(deletionEffect(target, [])).toBe('role-and-database');
  expect(deletionEffect(target, [{ ...target, id: 'c2' }])).toBe('role-only');
});

it('rejects contradictory reserved labels instead of guessing', () => {
  let thrown: unknown;
  try {
    parseConnectionLabels({ 'postgres.access': 'full', 'postgres.database': 'orders' });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ status: 409 });
});
