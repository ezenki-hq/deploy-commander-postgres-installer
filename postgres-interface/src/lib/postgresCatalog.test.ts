import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_DELETE_QUERY,
  CATALOG_LIST_QUERY,
  CATALOG_UPSERT_QUERY,
  buildCatalogDeleteHook,
  buildCatalogHook,
  catalogRecordId,
  listCatalogDatabases,
} from './postgresCatalog';

const resourceId = 'resource-1';
const access = { scope: 'database', operation: 'create', database: 'orders' } as const;

describe('postgres database catalog', () => {
  it('uses a deterministic record key and bound, origin-preserving upsert', () => {
    const first = buildCatalogHook(access, resourceId);
    const second = buildCatalogHook(access, resourceId);
    const query = first?.create?.before;

    expect(query).toEqual(second?.create?.before);
    expect(query?.query).toBe(CATALOG_UPSERT_QUERY);
    expect(query?.bindings).toEqual({
      record_id: catalogRecordId(resourceId, 'orders'),
      resource_id: resourceId,
      name: 'orders',
      origin: 'managed',
    });
    expect(CATALOG_UPSERT_QUERY).toContain('IF NOT EXISTS');
    expect(CATALOG_UPSERT_QUERY).toContain('COLUMNS resource_id, name UNIQUE');
    expect(CATALOG_UPSERT_QUERY).toContain("IF origin = 'managed' THEN 'managed'");
  });

  it('does not add catalog hooks for full access or existing-db cleanup', () => {
    expect(buildCatalogHook({ scope: 'full', superuser: false }, resourceId)).toBeUndefined();
    expect(buildCatalogDeleteHook({ scope: 'full', superuser: true }, resourceId)).toBeUndefined();
    expect(
      buildCatalogDeleteHook(
        { scope: 'database', operation: 'existing', database: 'orders' },
        resourceId,
      ),
    ).toBeUndefined();
  });

  it('deletes only the deterministic managed record', () => {
    const hook = buildCatalogDeleteHook(access, resourceId);
    expect(hook?.remove?.after).toEqual({
      query: CATALOG_DELETE_QUERY,
      bindings: { record_id: catalogRecordId(resourceId, 'orders') },
    });
    expect(CATALOG_DELETE_QUERY).toContain("origin = 'managed'");
  });

  it('lists unique, valid catalog names and binds the resource', async () => {
    const databaseQuery = vi.fn().mockResolvedValue({
      results: [{ status: 'OK', result: [{ name: 'orders' }, { name: 'warehouse' }] }],
    });
    await expect(listCatalogDatabases({ databaseQuery }, resourceId)).resolves.toEqual([
      'orders',
      'warehouse',
    ]);
    expect(databaseQuery).toHaveBeenCalledWith(CATALOG_LIST_QUERY, { resource_id: resourceId });
  });

  it.each([
    { results: [{ status: 'ERR', result: 'boom' }] },
    { results: [{ status: 'OK', result: [{ name: '' }] }] },
    { results: [{ status: 'OK', result: [{ name: 'orders' }, { name: 'orders' }] }] },
    { results: [{ status: 'OK', result: [{ name: 'orders', resource_id: 'other-resource' }] }] },
  ])('rejects an unsafe catalog response', async (response) => {
    const databaseQuery = vi.fn().mockResolvedValue(response);
    await expect(listCatalogDatabases({ databaseQuery }, resourceId)).rejects.toThrow(
      'Invalid PostgreSQL database catalog response',
    );
  });
});
