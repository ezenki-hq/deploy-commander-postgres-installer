import type { AccessRequest } from './requests';

export type AdminCredentials = {
  username: string;
  password: string;
};

export type LoginCredentials = {
  username: string;
  password: string;
};

export type LoginIdentity = {
  callerId: string;
  resourceId: string;
  access: AccessRequest;
};

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function accessIdentity(access: AccessRequest): string {
  return access.scope === 'database'
    ? [access.scope, access.database].join('|')
    : [access.scope, String(access.superuser)].join('|');
}

function canonicalIdentity(parts: string[]): Uint8Array {
  return new TextEncoder().encode(parts.map((part) => `${part.length}:${part}`).join('|'));
}

async function identityDigest(parts: string[]): Promise<string> {
  const bytes = canonicalIdentity(parts);
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest).slice(0, 16), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

export function generateAdminCredentials(): AdminCredentials {
  return {
    username: `dc_admin_${randomHex(16)}`,
    password: randomHex(32),
  };
}

export async function generateLoginCredentials(identity: LoginIdentity): Promise<LoginCredentials> {
  const suffix = await identityDigest([
    identity.callerId,
    identity.resourceId,
    accessIdentity(identity.access),
  ]);
  return {
    username: `dc_user_${suffix}`,
    password: randomHex(32),
  };
}

export async function databaseOwnerRole(resourceId: string, database: string): Promise<string> {
  return `dc_db_${await identityDigest([resourceId, database])}`;
}
