// =============================================================================
// Vector store against a real ChromaDB server
// =============================================================================
// The unit tests mock fetch, so nothing noticed that Chroma 1.x answers every
// /api/v1 route with 410 Gone: the client used v1, every call failed, and the
// container healthcheck (curl, absent from the image, on a v1 URL) could never
// pass. This runs the real client against the pinned Chroma image; CI's
// vector-store-tests job sets CHROMA_INTEGRATION_URL. Without it, it is skipped.
// =============================================================================

const url = process.env.CHROMA_INTEGRATION_URL;
const run = url ? describe : describe.skip;

run('vectorStoreService against ChromaDB', () => {
  let svc;
  const collection = `ci_${Date.now()}`;

  beforeAll(() => {
    process.env.CHROMA_URL = url;
    process.env.VECTOR_RETRIEVAL_ENABLED = 'true';
    jest.resetModules();
    svc = require('../../src/services/vectorStoreService');
  });

  test('a collection is created, then returned again by name', async () => {
    const id = await svc.ensureCollection(collection);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    svc._clearCacheForTesting();
    expect(await svc.ensureCollection(collection)).toBe(id);
  });

  test('upserted documents come back nearest-first, and deleted ones are gone', async () => {
    await svc.upsertDocuments({
      collection,
      ids: ['near', 'far'],
      embeddings: [[1, 0, 0], [0, 1, 0]],
      documents: ['Reiniciar el módem', 'Cambiar de plan'],
      metadatas: [{ locale: 'es-MX' }, { locale: 'es-MX' }],
    });

    const hits = await svc.queryDocuments({ collection, queryEmbedding: [0.9, 0.1, 0], k: 2 });
    expect(hits.ids).toEqual(['near', 'far']);
    expect(hits.documents[0]).toBe('Reiniciar el módem');
    expect(hits.metadatas[0]).toEqual({ locale: 'es-MX' });
    expect(hits.distances[0]).toBeLessThan(hits.distances[1]);

    await svc.deleteDocuments({ collection, ids: ['near'] });
    const after = await svc.queryDocuments({ collection, queryEmbedding: [1, 0, 0], k: 2 });
    expect(after.ids).toEqual(['far']);
  });
});
