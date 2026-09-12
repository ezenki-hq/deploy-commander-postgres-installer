import { describe, expect, it } from 'vitest';
import {
  generateAdminCredentials,
  generateConnectionCredentials,
  type RandomBytes,
} from './credentials';

function sequenceRandomBytes(): { random: RandomBytes; calls: number[] } {
  const calls: number[] = [];
  let value = 0;

  return {
    calls,
    random: (length) => {
      calls.push(length);
      return Uint8Array.from({ length }, () => value++ % 256);
    },
  };
}

describe('generateAdminCredentials', () => {
  it('generates a constrained identifier and base64url password', () => {
    const { random } = sequenceRandomBytes();
    const admin = generateAdminCredentials(random);

    expect(admin.username).toMatch(/^dc_admin_[0-9a-f]{32}$/);
    expect(admin.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('generateConnectionCredentials', () => {
  it('generates constrained independent database, username, and password values', () => {
    const { random } = sequenceRandomBytes();
    const logical = generateConnectionCredentials(random);

    expect(logical.database).toMatch(/^db_[0-9a-f]{32}$/);
    expect(logical.username).toMatch(/^dc_user_[0-9a-f]{32}$/);
    expect(logical.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('uses a separate 16- or 32-byte random call for every generated value', () => {
    const adminRandom = sequenceRandomBytes();
    generateAdminCredentials(adminRandom.random);
    expect(adminRandom.calls).toEqual([16, 32]);

    const logicalRandom = sequenceRandomBytes();
    generateConnectionCredentials(logicalRandom.random);
    expect(logicalRandom.calls).toEqual([16, 16, 32]);
  });

  it('does not reuse an administrator password for logical credentials', () => {
    const { random } = sequenceRandomBytes();
    const admin = generateAdminCredentials(random);
    const logical = generateConnectionCredentials(random);

    expect(admin.password).not.toBe(logical.password);
  });

  it('throws when a random provider returns the wrong byte length', () => {
    const invalidRandom: RandomBytes = () => new Uint8Array(1);

    expect(() => generateAdminCredentials(invalidRandom)).toThrow();
    expect(() => generateConnectionCredentials(invalidRandom)).toThrow();
  });
});
