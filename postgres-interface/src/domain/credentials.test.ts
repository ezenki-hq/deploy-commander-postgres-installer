import { expect, it } from 'vitest';
import {
  databaseOwnerRole,
  generateAdminCredentials,
  generateLoginCredentials,
} from './credentials';

it('derives stable distinct safe roles from identity', async () => {
  const first = await generateLoginCredentials({
    callerId: 'manager-a',
    resourceId: 'resource-1',
    access: { scope: 'database', operation: 'create', database: 'orders' },
  });
  const again = await generateLoginCredentials({
    callerId: 'manager-a',
    resourceId: 'resource-1',
    access: { scope: 'database', operation: 'create', database: 'orders' },
  });
  expect(first.username).toBe(again.username);
  expect(first.username).toMatch(/^dc_user_[0-9a-f]{32}$/);
  expect(first.password).not.toBe(again.password);
  await expect(databaseOwnerRole('resource-1', 'orders')).resolves.toMatch(/^dc_db_[0-9a-f]{32}$/);
});

it('derives distinct PostgreSQL logins for separate deployment groups', async () => {
  const access = { scope: 'database' as const, operation: 'create' as const, database: 'orders' };
  const first = await generateLoginCredentials({
    callerId: 'custom-deployer',
    resourceId: 'resource-1',
    groupId: 'group-1',
    access,
  });
  const sameGroup = await generateLoginCredentials({
    callerId: 'custom-deployer',
    resourceId: 'resource-1',
    groupId: 'group-1',
    access,
  });
  const otherGroup = await generateLoginCredentials({
    callerId: 'custom-deployer',
    resourceId: 'resource-1',
    groupId: 'group-2',
    access,
  });

  expect(first.username).toBe(sameGroup.username);
  expect(first.username).not.toBe(otherGroup.username);
});

it('generates nonblank administrator credentials', () => {
  expect(generateAdminCredentials()).toEqual({
    username: expect.stringMatching(/^dc_admin_[0-9a-f]{32}$/),
    password: expect.stringMatching(/^.{32,}$/),
  });
});
