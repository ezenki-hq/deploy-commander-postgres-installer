import type { RPCCaller } from '@ezenki/deploy-commander-installer-interface';
import { PostgresRequestError } from '../domain/errors';

const CREDENTIAL_KEYS = ['PASSWORD', 'USERNAME'];

export async function requireCredentialKeys(
  caller: RPCCaller,
  kind: 'resource' | 'connection',
  id: string,
): Promise<void> {
  let keys: unknown;
  try {
    keys = await caller.getSecretKeys(kind, id);
  } catch {
    throw new PostgresRequestError(400, 'PostgreSQL credentials are unavailable');
  }
  if (
    !Array.isArray(keys) ||
    keys.length !== CREDENTIAL_KEYS.length ||
    !CREDENTIAL_KEYS.every((key) => keys.includes(key))
  ) {
    throw new PostgresRequestError(400, 'PostgreSQL credentials are unavailable');
  }
}
