// =============================================================================
// VigaBSS 5.0 — Scheduler Service Unit Tests
// =============================================================================

// The no-Redis path claims each run with GET_LOCK + a per-minute UPDATE on a
// dedicated connection (ASY-01); this connection grants both.
const mockConnection = {
  query: jest.fn(async (sql) => {
    if (/GET_LOCK/.test(sql)) return [[{ acquired: 1 }]];
    if (/RELEASE_LOCK/.test(sql)) return [[{ released: 1 }]];
    return [{ affectedRows: 1 }];
  }),
  release: jest.fn(),
  destroy: jest.fn(),
};
jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  getLockConnection: jest.fn(async () => mockConnection),
}));

jest.mock('node-cron', () => ({
  validate: jest.fn(),
  schedule: jest.fn(),
}));

jest.mock('../src/services/taskRunner', () => ({
  runTask: jest.fn(),
  markTaskRun: jest.fn(),
  executeScheduledTask: jest.fn(),
}));

jest.mock('../src/services/jobQueueService', () => ({
  add: jest.fn(),
}));

const db = require('../src/config/database');
const cron = require('node-cron');
const taskRunner = require('../src/services/taskRunner');
const jobQueue = require('../src/services/jobQueueService');
const scheduler = require('../src/services/scheduler');

describe('Scheduler Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    scheduler.stop();
    delete process.env.REDIS_URL;
  });

  describe('start()', () => {
    test('loads enabled tasks and schedules them', async () => {
      db.query.mockResolvedValueOnce([[
        { id: 1, task_name: 'auto_generate_invoices', cron_expression: '0 2 * * *', organization_id: 1 },
      ]]);
      cron.validate.mockReturnValue(true);
      cron.schedule.mockReturnValue({ stop: jest.fn() });

      await scheduler.start();

      expect(db.query).toHaveBeenCalledWith(expect.stringContaining('is_enabled = 1'));
      expect(cron.schedule).toHaveBeenCalledTimes(1);
    });

    test('skips tasks with invalid cron expressions', async () => {
      db.query.mockResolvedValueOnce([[
        { id: 1, task_name: 'bad_task', cron_expression: 'bad', organization_id: null },
      ]]);
      cron.validate.mockReturnValue(false);

      await scheduler.start();
      expect(cron.schedule).not.toHaveBeenCalled();
    });

    test('handles empty task list', async () => {
      db.query.mockResolvedValueOnce([[]]);
      await scheduler.start();
      expect(cron.schedule).not.toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    test('stops all scheduled jobs', async () => {
      const mockStop = jest.fn();
      db.query.mockResolvedValueOnce([[
        { id: 1, task_name: 'test_task', cron_expression: '* * * * *', organization_id: null },
      ]]);
      cron.validate.mockReturnValue(true);
      cron.schedule.mockReturnValue({ stop: mockStop });

      await scheduler.start();
      scheduler.stop();

      expect(mockStop).toHaveBeenCalled();
    });
  });

  describe('getStatus()', () => {
    test('returns status of registered jobs', async () => {
      db.query.mockResolvedValueOnce([[
        { id: 1, task_name: 'task_a', cron_expression: '0 1 * * *', organization_id: null },
        { id: 2, task_name: 'task_b', cron_expression: '0 2 * * *', organization_id: null },
      ]]);
      cron.validate.mockReturnValue(true);
      cron.schedule.mockReturnValue({ stop: jest.fn() });

      await scheduler.start();
      const status = scheduler.getStatus();

      expect(status).toEqual(expect.arrayContaining([
        expect.objectContaining({ task_name: 'task_a' }),
        expect.objectContaining({ task_name: 'task_b' }),
      ]));
      scheduler.stop();
    });
  });

  describe('task completion status', () => {
    test('runs the exact task row through the recorder (ASY-28)', async () => {
      let callback;
      const task = {
        id: 455,
        task_name: 'poll_pppoe_events',
        cron_expression: '*/5 * * * *',
        organization_id: null,
      };
      db.query.mockResolvedValueOnce([[task]]).mockResolvedValue([{ affectedRows: 1 }]);
      cron.validate.mockReturnValue(true);
      cron.schedule.mockImplementation((_expression, handler) => {
        callback = handler;
        return { stop: jest.fn() };
      });
      taskRunner.executeScheduledTask.mockResolvedValueOnce({ skipped: true, reason: 'already_running' });

      await scheduler.start();
      await callback();

      // executeScheduledTask records the outcome, an overlap skip or a throw
      // included, on this exact row.
      expect(taskRunner.executeScheduledTask).toHaveBeenCalledWith(expect.objectContaining({ id: 455 }), 'cron');
    });

    test('a task that throws is logged and the lock is still released', async () => {
      let callback;
      const task = { id: 456, task_name: 'boom', cron_expression: '* * * * *', organization_id: null };
      db.query.mockResolvedValueOnce([[task]]).mockResolvedValue([{ affectedRows: 1 }]);
      cron.validate.mockReturnValue(true);
      cron.schedule.mockImplementation((_expression, handler) => {
        callback = handler;
        return { stop: jest.fn() };
      });
      taskRunner.executeScheduledTask.mockRejectedValueOnce(new Error('boom'));

      await scheduler.start();
      await expect(callback()).resolves.toBeUndefined();

      expect(mockConnection.query).toHaveBeenCalledWith('SELECT RELEASE_LOCK(?) AS released', [expect.stringContaining(':scheduled-task:456')]);
      expect(mockConnection.release).toHaveBeenCalled();
    });

    test('drain() waits for an inline run still in progress (ASY-28)', async () => {
      let callback;
      let finish;
      const task = { id: 457, task_name: 'slow', cron_expression: '* * * * *', organization_id: null };
      db.query.mockResolvedValueOnce([[task]]).mockResolvedValue([{ affectedRows: 1 }]);
      cron.validate.mockReturnValue(true);
      cron.schedule.mockImplementation((_expression, handler) => {
        callback = handler;
        return { stop: jest.fn() };
      });
      taskRunner.executeScheduledTask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

      await scheduler.start();
      const tick = callback();
      await new Promise(resolve => setImmediate(resolve));
      scheduler.stop();

      let drained = false;
      const draining = scheduler.drain(5000).then((left) => { drained = true; return left; });
      await new Promise(resolve => setImmediate(resolve));
      expect(drained).toBe(false);

      finish({ processed: 1 });
      await expect(draining).resolves.toBe(0);
      await tick;
    });

    test('includes the exact task id in the BullMQ job payload', async () => {
      process.env.REDIS_URL = 'redis://test.invalid';
      let callback;
      const task = {
        id: 455,
        task_name: 'poll_pppoe_events',
        cron_expression: '*/5 * * * *',
        organization_id: null,
      };
      db.query.mockResolvedValueOnce([[task]]);
      cron.validate.mockReturnValue(true);
      cron.schedule.mockImplementation((_expression, handler) => {
        callback = handler;
        return { stop: jest.fn() };
      });
      jobQueue.add.mockResolvedValueOnce({ id: 'queued' });

      await scheduler.start();
      await callback();

      expect(jobQueue.add).toHaveBeenCalledWith(
        'scheduled-task',
        { taskId: 455, taskName: 'poll_pppoe_events', organizationId: null },
        expect.objectContaining({ jobId: expect.stringContaining('poll_pppoe_events') }),
      );
    });
  });
});
