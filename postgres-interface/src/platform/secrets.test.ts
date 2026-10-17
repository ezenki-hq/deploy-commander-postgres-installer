import { describe, expect, it, vi } from 'vitest';
import { fakeCaller } from '../test/fakes';
import { requireCredentialKeys } from './secrets';

describe('requireCredentialKeys', () => {
  it('requires username and password keys without reading values', async () => {
    const getSecretKeys = vi.fn().mockResolvedValue(['USERNAME', 'PASSWORD']);
    const caller = fakeCaller({ getSecretKeys });
    await expect(requireCredentialKeys(caller, 'resource', 'resource-1')).resolves.toBeUndefined();
    expect(getSecretKeys).toHaveBeenCalledWith('resource', 'resource-1');
  });

  it('rejects a missing credential key', async () => {
    const caller = fakeCaller({ getSecretKeys: vi.fn().mockResolvedValue(['USERNAME']) });
    await expect(requireCredentialKeys(caller, 'connection', 'connection-1')).rejects.toMatchObject({
      status: 400,
    });
  });
});
