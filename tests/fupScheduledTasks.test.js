// =============================================================================
// ASY-36 — the FUP scheduled tasks run for every organization
// =============================================================================
// check_fup_thresholds and fup_threshold_notify returned { deferred: true },
// and convert_expired_trials had nothing to convert (invoices price the
// trial window, BIL-13). Migration 519 enables the first two and removes the
// third.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), withPrimaryContext: fn => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/services/fupService', () => ({ checkFupThresholds: jest.fn(async () => ({ throttled: 1 })) }));
jest.mock('../src/services/fupNotificationService', () => ({ checkAndNotifyThresholds: jest.fn(async () => ({ notified: 2 })) }));

const db = require('../src/config/database');
const fupService = require('../src/services/fupService');
const fupNotificationService = require('../src/services/fupNotificationService');
const taskRunner = require('../src/services/taskRunner');

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql) => (/FROM organizations o/.test(sql)
    ? [[{ id: 1, database_scope: 'shared' }, { id: 2, database_scope: 'shared' }]]
    : [[]]));
});

test.each([
  ['check_fup_thresholds', () => fupService.checkFupThresholds],
  ['fup_threshold_notify', () => fupNotificationService.checkAndNotifyThresholds],
])('%s runs for the row\'s organization, or every active one', async (task, handler) => {
  const result = await taskRunner.runTask(task, 42);
  expect(result).not.toHaveProperty('deferred');
  expect(handler()).toHaveBeenCalledWith(42);
  handler().mockClear();
  await taskRunner.runTask(task, null);
  expect(handler().mock.calls).toEqual([[1], [2]]);
});

test('convert_expired_trials is gone: no dispatcher case, and no install seeds its row', async () => {
  expect((await taskRunner.runTask('convert_expired_trials')).message).toMatch(/^Unknown task/);
  const { migratedSeeds } = require('./helpers/scheduledTaskSeeds');
  const seeds = migratedSeeds();
  expect(seeds.find(r => r.task_name === 'convert_expired_trials')).toBeUndefined();
  expect(seeds.filter(r => ['check_fup_thresholds', 'fup_threshold_notify'].includes(r.task_name)).map(r => Number(r.is_enabled)))
    .toEqual([1, 1]);
});
