// runWithConcurrency keeps a fixed number of items in flight. The property that
// matters to the SNMP pollers: a slow item occupies one slot, and nothing else
// waits on it — unlike batches, where a batch ends only when its slowest item does.

const { runWithConcurrency } = require('../src/utils/concurrency');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(times = 20) { for (let i = 0; i < times; i += 1) await tick(); }

test('never runs more than the limit at once, and runs every item', async () => {
  let inFlight = 0;
  let peak = 0;
  const seen = [];
  const results = await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await tick();
    inFlight -= 1;
    seen.push(n);
    return n * 10;
  });
  expect(peak).toBe(3);
  expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(results.map(r => r.value)).toEqual([10, 20, 30, 40, 50, 60, 70]);
});

test('an item that never finishes does not hold up the rest', async () => {
  let release;
  const stuck = new Promise((resolve) => { release = resolve; });
  const done = [];
  const run = runWithConcurrency(['stuck', 'a', 'b', 'c', 'd', 'e'], 2, async (item) => {
    if (item === 'stuck') await stuck;
    done.push(item);
  });

  await settle();
  // With batches of two, 'b'..'e' would still be waiting behind 'stuck'.
  expect(done).toEqual(['a', 'b', 'c', 'd', 'e']);

  release();
  await run;
  expect(done).toHaveLength(6);
});

test('a worker that throws is reported in place and its slot carries on', async () => {
  const results = await runWithConcurrency(['ok', 'bad', 'ok2'], 1, async (item) => {
    if (item === 'bad') throw new Error('boom');
    return item;
  });
  expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok' });
  expect(results[1].status).toBe('rejected');
  expect(results[1].reason.message).toBe('boom');
  expect(results[2]).toEqual({ status: 'fulfilled', value: 'ok2' });
});

test.each([[0], [-4], [NaN], [undefined], ['x']])('a limit of %p runs one at a time instead of stalling', async (limit) => {
  let inFlight = 0;
  let peak = 0;
  const results = await runWithConcurrency([1, 2, 3], limit, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await tick();
    inFlight -= 1;
  });
  expect(peak).toBe(1);
  expect(results).toHaveLength(3);
});

test('an empty list resolves to an empty result', async () => {
  const worker = jest.fn();
  expect(await runWithConcurrency([], 10, worker)).toEqual([]);
  expect(worker).not.toHaveBeenCalled();
});
