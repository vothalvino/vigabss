// =============================================================================
// Scheduled-task locks never starve the request pool
// =============================================================================
// runClaimed held each task's advisory lock on a connection from the request
// pool for the whole run, and the task's own queries needed a second one. When
// as many tasks as the pool has connections came due at one 5-minute mark (20
// in the e2e database), every connection held a lock and every task waited for
// one more: the API answered nothing but 504 until a restart.
// =============================================================================

// A request pool with a fixed number of connections; a query borrows one.
const mockPool = { size: 2, inUse: 0, waiting: [] };
function mockAcquire() {
  if (mockPool.inUse < mockPool.size) {
    mockPool.inUse++;
    return Promise.resolve();
  }
  return new Promise(resolve => mockPool.waiting.push(resolve));
}
function mockRelease() {
  const next = mockPool.waiting.shift();
  if (next) next();
  else mockPool.inUse--;
}
function mockLockSession() {
  return {
    query: jest.fn(async (sql) => {
      if (/GET_LOCK/.test(sql)) return [[{ acquired: 1 }]];
      if (/RELEASE_LOCK/.test(sql)) return [[{ released: 1 }]];
      return [{ affectedRows: 1 }];
    }),
    release: jest.fn(),
    destroy: jest.fn(),
  };
}

jest.mock('../src/config/database', () => ({
  query: jest.fn(async () => {
    await mockAcquire();
    mockRelease();
    return [[]];
  }),
  getConnection: jest.fn(async () => {
    await mockAcquire();
    return { ...mockLockSession(), release: jest.fn(mockRelease) };
  }),
  getLockConnection: jest.fn(async () => mockLockSession()),
  baseConnectionConfig: { database: 'vigabss_test' },
}));

const db = require('../src/config/database');
const { runClaimed } = require('../src/services/scheduler');

test('more due tasks than request connections all finish', async () => {
  const tasks = [1, 2, 3, 4].map(id => ({ id, task_name: `task_${id}`, organization_id: null }));
  const work = jest.fn(() => db.query('SELECT 1'));

  const runs = Promise.all(tasks.map(task => runClaimed(task, work)));
  const deadlocked = new Promise(resolve => setTimeout(() => resolve('deadlocked'), 500));

  await expect(Promise.race([runs, deadlocked])).resolves.toEqual([true, true, true, true]);
  expect(work).toHaveBeenCalledTimes(4);
  expect(db.getConnection).not.toHaveBeenCalled();
  expect(mockPool.inUse).toBe(0);
});
