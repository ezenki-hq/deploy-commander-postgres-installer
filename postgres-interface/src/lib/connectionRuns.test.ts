import { describe, expect, it } from 'vitest';
import type { RPC } from '@ezenki/deploy-commander-installer-interface';
import { makeCleanupNote, makeProvisionNote, parseCleanupRun, parseConnectionNote, parseProvisionRun } from './connectionRuns';
const identity = { operationId: '01234567-89ab-4def-8123-456789abcdef', callerId: 'consumer:manager % one', resourceId: 'resource:one/ä' };
const database = 'db_0123456789abcdef0123456789abcdef'; const username = 'dc_user_0123456789abcdef0123456789abcdef';
function runResult(action: string, note: string, status = 2, id = `${action}-run`): RPC.GetRun {
  return { run: { id, action, note, status, queued_at: '2026-09-11T00:00:00.000Z', created_at: '2026-09-11T00:00:00.000Z', updated_at: '2026-09-11T00:00:00.000Z' }, config: { id, action, manager: 'manager-1', run: id, runner: 'ezenki/deploy-commander-runner:latest', metadata: { services: { 'postgres-admin': { image: 'postgres:15', role: 'runner', environment: { PGHOST: 'postgres', PGPORT: '5432', PGDATABASE: 'postgres', PGUSER: 'dc_admin_0123456789abcdef0123456789abcdef', PGPASSWORD: 'admin-secret', TARGET_DATABASE: database, TARGET_USERNAME: username, ...(action === 'create-connection' ? { TARGET_PASSWORD: 'logical-password' } : {}) }, command: ['sh', '-ceu', 'script'] } } } } } as RPC.GetRun;
}
describe('connection run notes', () => {
  it('round-trips versioned notes without leaking logical secrets', () => { expect(parseConnectionNote(makeProvisionNote(identity))).toEqual({ kind: 'provision', ...identity }); expect(parseConnectionNote(makeCleanupNote(identity))).toEqual({ kind: 'cleanup', ...identity }); expect(makeProvisionNote(identity)).not.toContain('logical-password'); });
  it.each(['postgres-provision:v2:caller:resource:01234567-89ab-4def-8123-456789abcdef', 'postgres-provision:v1:%E0%A4%A:resource:01234567-89ab-4def-8123-456789abcdef', 'postgres-provision:v1::resource:01234567-89ab-4def-8123-456789abcdef', 'postgres-provision:v1:caller:resource:not-an-operation', 'postgres-unknown:v1:caller:resource:01234567-89ab-4def-8123-456789abcdef'])('rejects malformed note %s', note => expect(() => parseConnectionNote(note)).toThrow());
});
describe('connection run records', () => {
  it('parses a successful provision run', () => { expect(parseProvisionRun(runResult('create-connection', makeProvisionNote(identity), 2, 'provision-run'))).toEqual({ identity, runId: 'provision-run', status: 2, logical: { database, username, password: 'logical-password' } }); });
  it('parses cleanup without administrator credentials', () => { expect(parseCleanupRun(runResult('cleanup-connection', makeCleanupNote(identity), 2, 'cleanup-run'))).toEqual({ identity, runId: 'cleanup-run', status: 2, database, username }); });
  it.each([['create-connection', makeCleanupNote(identity)], ['wrong-action', makeProvisionNote(identity)]])('rejects action/note mismatch', (action, note) => expect(() => parseProvisionRun(runResult(action, note))).toThrow());
  it('rejects invalid service boundary and malformed credentials', () => { const result = runResult('create-connection', makeProvisionNote(identity)); const service = result.config.metadata.services['postgres-admin']; service.role = 'service'; expect(() => parseProvisionRun(result)).toThrow(); service.role = 'runner'; service.environment.TARGET_DATABASE = 'unsafe database'; expect(() => parseProvisionRun(result)).toThrow(); service.environment.TARGET_DATABASE = database; service.environment.TARGET_PASSWORD = '   '; expect(() => parseProvisionRun(result)).toThrow(); });
  it('rejects a target username in the reserved PostgreSQL namespace', () => { const result = runResult('create-connection', makeProvisionNote(identity)); result.config.metadata.services['postgres-admin'].environment.TARGET_USERNAME = 'pg_user_0123456789abcdef0123456789abcdef'; expect(() => parseProvisionRun(result)).toThrow(); });
  it.each([
    ['PGHOST', undefined], ['PGPORT', 'not-a-port'], ['PGDATABASE', 'wrong-database'],
    ['PGUSER', ''], ['PGUSER', 'pg_admin_0123456789abcdef0123456789abcdef'], ['PGPASSWORD', ''],
  ])('rejects missing or malformed administrator environment field %s', (field, value) => {
    const result = runResult('create-connection', makeProvisionNote(identity));
    if (value === undefined) delete result.config.metadata.services['postgres-admin'].environment[field];
    else result.config.metadata.services['postgres-admin'].environment[field] = value;
    expect(() => parseProvisionRun(result)).toThrow();
  });
  it('rejects note/config identity mismatch', () => { const result = runResult('create-connection', makeProvisionNote(identity)); result.config.run = 'other-run'; expect(() => parseProvisionRun(result)).toThrow(); });
});
