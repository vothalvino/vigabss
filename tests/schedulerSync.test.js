// =============================================================================
// ASY-18 — scheduled-task changes take effect without a restart
// =============================================================================
// scheduler.start() loaded the enabled rows once at boot and nothing called it
// again, so an operator-created task never ran, an edit never applied, and a
// disabled or deleted task kept firing until every process restarted. A
// BullMQ job queued before the row was disabled still ran.
// =============================================================================

const mockHandles = [];
jest.mock('node-cron', () => ({
  validate: () => true,
  schedule: jest.fn((expression, callback) => {
    const handle = { expression, callback, stop: jest.fn(), destroy: jest.fn() };
    mockHandles.push(handle);
    return handle;
  }),
}));
jest.mock('../src/config/database', () => ({
  query: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
  withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));

const cron = require('node-cron');
const db = require('../src/config/database');
const scheduler = require('../src/services/scheduler');

let rows;
beforeEach(() => {
  jest.clearAllMocks();
  mockHandles.length = 0;
  rows = [
    { id: 1, task_name: 'billing_cycle', cron_expression: '0 2 * * *', organization_id: null, is_enabled: 1 },
    { id: 7, task_name: 'radius_sync', cron_expression: '*/5 * * * *', organization_id: 3, is_enabled: 1 },
  ];
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM scheduled_tasks WHERE is_enabled = 1/.test(sql)) return [rows.filter((r) => r.is_enabled)];
    if (/SELECT is_enabled FROM scheduled_tasks WHERE id = \?/.test(sql)) return [rows.filter((r) => r.id === params[0])];
    return [[]];
  });
});
afterEach(() => scheduler.stop());

const scheduledIds = () => scheduler.getStatus().map((s) => s.task_id).sort((a, b) => a - b);

test('created, edited, disabled and deleted rows reach the running scheduler', async () => {
  await scheduler.start();
  expect(scheduledIds()).toEqual([1, 7]);

  rows.push({ id: 9, task_name: 'sms_send', cron_expression: '* * * * *', organization_id: 3, is_enabled: 1 });
  await scheduler.reload();
  expect(scheduledIds()).toEqual([1, 7, 9]);

  const radiusHandle = mockHandles.find((h) => h.expression === '*/5 * * * *');
  rows[1].cron_expression = '*/15 * * * *';
  await scheduler.reload();
  expect(radiusHandle.destroy).toHaveBeenCalled();
  expect(mockHandles.some((h) => h.expression === '*/15 * * * *')).toBe(true);

  rows[0].is_enabled = 0;            // disabled
  rows = rows.filter((r) => r.id !== 9); // deleted
  await scheduler.reload();
  expect(scheduledIds()).toEqual([7]);
});

test('an unchanged row keeps its handle', async () => {
  await scheduler.start();
  const before = cron.schedule.mock.calls.length;
  await scheduler.sync();
  expect(cron.schedule.mock.calls.length).toBe(before);
});

test('start() keeps every process in sync each minute', async () => {
  jest.useFakeTimers();
  try {
    await scheduler.start();
    rows.push({ id: 11, task_name: 'sms_send', cron_expression: '* * * * *', organization_id: null, is_enabled: 1 });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(scheduledIds()).toEqual([1, 7, 11]);
  } finally {
    scheduler.stop();
    jest.useRealTimers();
  }
});

test('reload() does nothing in a process that does not run the scheduler', async () => {
  await scheduler.reload();
  expect(db.query).not.toHaveBeenCalled();
  expect(cron.schedule).not.toHaveBeenCalled();
});

test('the API reloads the scheduler after a task is created, updated or deleted', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'scheduledTasks.js'), 'utf8');
  const options = src.match(/crudController\(ScheduledTask, \{([\s\S]*?)\}\);/)[1];
  for (const hook of ['afterCreate', 'afterUpdate', 'afterDelete']) expect(options).toMatch(new RegExp(`${hook}: reloadScheduler`));
});

describe('the BullMQ scheduled-task worker', () => {
  const jobQueue = require('../src/services/jobQueueService');
  const taskRunner = require('../src/services/taskRunner');

  test('skips a job whose task was disabled or deleted after it was queued', async () => {
    const processSpy = jest.spyOn(jobQueue, 'process');
    require('../src/workers').registerWorkers();
    const handler = processSpy.mock.calls.find(([name]) => name === 'scheduled-task')[1];
    const runSpy = jest.spyOn(taskRunner, 'runTask').mockResolvedValue({ ok: true });
    jest.spyOn(taskRunner, 'markTaskRun').mockResolvedValue(undefined);

    rows[0].is_enabled = 0;
    await expect(handler({ data: { taskId: 1, taskName: 'billing_cycle' } })).resolves.toMatchObject({ skipped: true });
    await expect(handler({ data: { taskId: 404, taskName: 'gone' } })).resolves.toMatchObject({ skipped: true });
    expect(runSpy).not.toHaveBeenCalled();

    await handler({ data: { taskId: 7, taskName: 'radius_sync', organizationId: 3 } });
    expect(runSpy).toHaveBeenCalledWith('radius_sync', 3);
  });
});
