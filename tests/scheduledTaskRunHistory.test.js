// =============================================================================
// ASY-28 — every scheduled task run is recorded, a failure included
// =============================================================================
// The BullMQ worker (the production path with REDIS_URL) recorded nothing
// when a task threw, so the row kept its previous 'success'; no path wrote
// last_error or last_duration_ms; there was no run history; and nothing
// measured how long a run took. executeScheduledTask() now records every run
// from the cron path, the worker and a manual run.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(async () => [{ affectedRows: 1 }]),
  withPrimaryContext: jest.fn(fn => fn()),
  withTenantContext: jest.fn((_id, fn) => fn()),
}));

const db = require('../src/config/database');
const opsMetrics = require('../src/utils/opsMetrics');
const taskRunner = require('../src/services/taskRunner');

const TASK = { id: 41, task_name: 'ftth_onu_discovery', organization_id: null };

function writes(pattern) {
  return db.query.mock.calls.filter(([sql]) => pattern.test(sql));
}

beforeEach(() => {
  db.query.mockClear();
  jest.restoreAllMocks();
});

test('a run that throws is recorded as failed with its error, then rethrown', async () => {
  const noteSpy = jest.spyOn(opsMetrics, 'noteTaskRun');
  // Not approved for organization scope: runTask throws before any work.
  const task = { id: 42, task_name: 'database_backup', organization_id: 9 };

  await expect(taskRunner.executeScheduledTask(task, 'worker')).rejects.toThrow(/not approved for organization-scoped execution/);

  const [[updateSql, updateParams]] = writes(/UPDATE scheduled_tasks/);
  expect(updateSql).toMatch(/last_status = \?, last_error = \?, last_duration_ms = \?/);
  expect(updateSql).toMatch(/retry_count = IF\(\? = 'failed', LEAST\(retry_count \+ 1, max_retries\), 0\)/);
  expect(updateParams[0]).toBe('failed');
  expect(updateParams[1]).toMatch(/not approved/);
  expect(updateParams[4]).toBe(42);

  const [[, historyParams]] = writes(/INSERT INTO scheduled_task_runs/);
  expect(historyParams.slice(0, 5)).toEqual([42, 9, 'database_backup', 'worker', 'failed']);
  expect(historyParams[8]).toMatch(/not approved/);
  expect(noteSpy).toHaveBeenCalledWith('database_backup', 'failed', expect.any(Number));
});

test('a deferred handler is recorded as skipped, with its duration', async () => {
  const result = await taskRunner.executeScheduledTask(TASK, 'cron');

  expect(result).toMatchObject({ deferred: true });
  const [[, updateParams]] = writes(/UPDATE scheduled_tasks/);
  expect(updateParams[0]).toBe('skipped');
  expect(updateParams[1]).toBeNull();
  expect(Number.isInteger(updateParams[2])).toBe(true);
  const [[, historyParams]] = writes(/INSERT INTO scheduled_task_runs/);
  expect(historyParams.slice(0, 5)).toEqual([41, null, 'ftth_onu_discovery', 'cron', 'skipped']);
  expect(historyParams[5]).toBeInstanceOf(Date);
  expect(historyParams[6].getTime()).toBeGreaterThanOrEqual(historyParams[5].getTime());
  expect(historyParams[9]).toMatch(/:\d+$/);
});

test('a completed run is recorded as success and resets the failure count', async () => {
  await taskRunner.executeScheduledTask({ id: 43, task_name: 'not_a_real_task_name', organization_id: null }, 'manual');

  const [[, updateParams]] = writes(/UPDATE scheduled_tasks/);
  expect(updateParams[0]).toBe('success');
  expect(updateParams[3]).toBe('success');
  const [[, historyParams]] = writes(/INSERT INTO scheduled_task_runs/);
  expect(historyParams[3]).toBe('manual');
});

test('an overlap that never ran is recorded in history only, leaving the running row alone', async () => {
  await taskRunner.recordTaskRun(TASK, {
    status: 'skipped', startedAt: new Date(), durationMs: 0, error: 'Previous run still in progress', via: 'worker', updateTask: false,
  });

  expect(writes(/UPDATE scheduled_tasks/)).toHaveLength(0);
  const [[, historyParams]] = writes(/INSERT INTO scheduled_task_runs/);
  expect(historyParams[4]).toBe('skipped');
  expect(historyParams[8]).toBe('Previous run still in progress');
});

test('a failure to record does not hide the task result', async () => {
  db.query.mockRejectedValue(new Error('db down'));
  try {
    await expect(taskRunner.executeScheduledTask(TASK, 'cron')).resolves.toMatchObject({ deferred: true });
  } finally {
    db.query.mockReset();
    db.query.mockImplementation(async () => [{ affectedRows: 1 }]);
  }
});

test('run durations are exported as a histogram', () => {
  opsMetrics.noteTaskRun('histogram_probe', 'success', 1500);
  const { registry } = require('../src/utils/metricsRegistry');
  const text = registry.render();
  return Promise.resolve(text).then((body) => {
    expect(body).toMatch(/scheduled_task_duration_seconds_bucket\{task="histogram_probe",le="5"\} 1/);
  });
});

test('the alert rules page someone when scheduled tasks fail', () => {
  const fs = require('fs');
  const path = require('path');
  for (const file of ['k8s/prometheus-alerts.yaml', 'charts/fireisp/templates/prometheus-alerts.yaml']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    expect(text).toMatch(/alert: VigaBSS_ScheduledTaskFailures/);
    expect(text).toMatch(/scheduled_task_runs_total\{status="failed"\}/);
  }
});
