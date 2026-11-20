// =============================================================================
// VigaBSS 5.0 — Bounded concurrency
// =============================================================================
// Run a worker over a list with at most `limit` items in flight, starting the
// next item the moment a slot frees.
//
// This is NOT the same as slicing the list into batches of `limit` and awaiting
// each batch: a batch finishes only when its slowest item does, so one device
// that never answers held up the nine polled beside it for its whole timeout,
// and the batch after them as well. Here a slow item occupies one slot and
// nothing else waits on it.
// =============================================================================

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} limit    most items in flight; anything below 1 runs one at a time
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<Array<{status: 'fulfilled', value: R} | {status: 'rejected', reason: unknown}>>}
 *          one entry per item, in input order (the shape of Promise.allSettled).
 *          Never rejects: a worker that throws is recorded and its slot carries on.
 */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  const width = Math.min(items.length, Math.max(1, Math.floor(Number(limit)) || 1));
  let next = 0;

  const slot = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: width }, slot));
  return results;
}

module.exports = { runWithConcurrency };
