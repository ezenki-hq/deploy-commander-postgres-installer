/**
 * Compatibility boundary for the pre-approval connection workflow.
 *
 * New connection requests must use LoginCredentials plus an approved
 * AccessRequest; this module exists only while the old workflow is migrated.
 */
import type { RandomBytes } from './credentials';

export interface LogicalCredentials {
  database: string;
  username: string;
  password: string;
}

const browserRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

function getBytes(random: RandomBytes, length: number): Uint8Array {
  const bytes = random(length);
  if (bytes.length !== length) {
    throw new Error('Random byte generator returned an invalid length');
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function generateConnectionCredentials(
  random: RandomBytes = browserRandomBytes,
): LogicalCredentials {
  return {
    database: `db_${toHex(getBytes(random, 16))}`,
    username: `dc_user_${toHex(getBytes(random, 16))}`,
    password: toBase64Url(getBytes(random, 32)),
  };
}
