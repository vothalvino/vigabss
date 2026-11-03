// =============================================================================
// VigaBSS 5.0 — Scheduler Service
// =============================================================================
// Loads enabled scheduled_tasks from the database, schedules them with
// node-cron, and dispatches each run through taskRunner (single-instance) or
// BullMQ (when REDIS_URL is set — for horizontally-scaled deployments).
// =============================================================================

const cron = require('node-cron');
const db = require('../config/database');
const taskRunner = require('./taskRunner');
const { businessTimezone } = require('../utils/businessDate');
const logger = require('../utils/logger').child({ service: 'scheduler' });

const jobs = new Map();
const MINUTE_IN_MS = 60_000;
let syncTimer = null;

// Without Redis, every app process runs every cron tick. The lock used to be
// a get-then-set in cacheService, which without Redis is a per-process memory
// cache, so with two or more replicas (the shipped k8s/Helm default, and no
// REDIS_URL) every replica ran every task: autopay at 07:00, the hourly
// payment retries, SNMP polling (ASY-01). Two database guards now decide:
//   1. a MySQL advisory lock per task id, held for the whole run on a session
//      from the separate lock pool (db.getLockConnection), so a run never
//      overlaps a previous one still going, in this process or another;
//   2. a per-minute claim on the task row: only the process whose UPDATE
//      moves last_run_at into the current minute runs it.
const { withAdvisoryLock } = require('../utils/advisoryLock');

/**
 * Run `fn` while holding the task's advisory lock, so no other run of the
 * same task overlaps it in any process. Without the lock, `fn` does not run.
 * `claim(connection)` may refuse the run after the lock is taken.
 * @returns {Promise<boolean>} whether `fn` ran
 */
function runExclusive(task, fn, claim = null) {
  return withAdvisoryLock(`scheduled-task:${task.id}`, fn, claim);
}

/**
 * Run `fn` only if this process wins the task's lock and its minute slot.
 * @returns {Promise<boolean>} whether `fn` ran
 */
function runClaimed(task, fn) {
  return runExclusive(task, fn, async (connection) => {
    // Both sides of the comparison use the database clock.
    const [claim] = await connection.query(
      `UPDATE scheduled_tasks
          SET last_status = 'running', last_run_at = NOW()
        WHERE id = ? AND is_enabled = 1
          AND (last_run_at IS NULL OR last_run_at < DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:00'))`,
      [task.id],
    );
    if (Number(claim?.affectedRows) !== 1) {
      logger.debug({ taskName: task.task_name, taskId: task.id }, 'Scheduled task already ran this minute');
      return false;
    }
    return true;
  });
}

// Inline runs in progress, so shutdown can wait for them (ASY-28).
const inFlight = new Set();

function track(promise) {
  inFlight.add(promise);
  promise.finally(() => inFlight.delete(promise)).catch(() => {});
  return promise;
}

/**
 * Wait for inline runs still in progress, up to `timeoutMs`. Call after
 * stop(): a SIGTERM used to close the database under a running task.
 * @returns {Promise<number>} how many were still running at the deadline
 */
async function drain(timeoutMs = 20_000) {
  if (inFlight.size === 0) return 0;
  logger.info({ running: inFlight.size }, 'Waiting for scheduled tasks to finish');
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([Promise.allSettled([...inFlight]), deadline]);
  clearTimeout(timer);
  if (inFlight.size > 0) logger.warn({ running: inFlight.size }, 'Scheduled tasks still running at shutdown');
  return inFlight.size;
}

// What a scheduled handle was built from; a row whose signature changed is
// rescheduled.
const signature = task => [task.cron_expression, task.task_name, task.organization_id ?? ''].join('|');

function unschedule(taskId) {
  const entry = jobs.get(taskId);
  if (!entry) return;
  if (typeof entry.job.destroy === 'function') entry.job.destroy();
  else entry.job.stop();
  jobs.delete(taskId);
}

/**
 * Bring this process's cron handles in line with scheduled_tasks: schedule new
 * enabled rows, reschedule edited ones, stop disabled and deleted ones. Tasks
 * used to be loaded once at boot, so a created, edited, disabled or deleted
 * row had no effect until every process restarted (ASY-18). start() runs this
 * every minute so all replicas converge; the API calls reload() for the
 * process that made the change.
 */
async function sync() {
  const [tasks] = await (typeof db.withPrimaryContext === 'function'
    ? db.withPrimaryContext(() => db.query(
      'SELECT * FROM scheduled_tasks WHERE is_enabled = 1 AND cron_expression IS NOT NULL',
    ))
    : db.query('SELECT * FROM scheduled_tasks WHERE is_enabled = 1 AND cron_expression IS NOT NULL'));

  const current = new Set();
  for (const task of tasks) {
    current.add(task.id);
    const entry = jobs.get(task.id);
    if (entry && entry.signature === signature(task)) continue;
    unschedule(task.id);
    schedule(task);
  }
  for (const taskId of [...jobs.keys()]) {
    if (!current.has(taskId)) unschedule(taskId);
  }
  return tasks.length;
}

/** Apply scheduled_tasks changes now, if this process runs the scheduler. */
async function reload() {
  if (!syncTimer) return;
  try {
    await sync();
  } catch (err) {
    logger.error({ err }, 'Scheduler reload failed; the next periodic sync retries');
  }
}

/**
 * Load all enabled tasks from the DB, schedule them, and keep them in sync.
 */
async function start() {
  const taskCount = await sync();
  if (!syncTimer) {
    syncTimer = setInterval(() => {
      sync().catch(err => logger.error({ err }, 'Scheduler sync failed'));
    }, MINUTE_IN_MS);
    if (typeof syncTimer.unref === 'function') syncTimer.unref();
  }
  logger.info({ taskCount }, 'Scheduler started');
}

/**
 * Schedule a single task using its cron_expression.
 */
function schedule(task) {
  if (!cron.validate(task.cron_expression)) {
    logger.warn({ taskName: task.task_name, cronExpression: task.cron_expression }, 'Invalid cron expression for task');
    return;
  }

  // Cron times are business-local (BIL-34/ASY-29): '0 7 * * *' is 07:00 in
  // BUSINESS_TIMEZONE, not in the container's UTC.
  const job = cron.schedule(task.cron_expression, async () => {
    // BullMQ path: enqueue job with minute-granular deduplication ID so that
    // only one instance across multiple pods adds a job per cron tick.
    if (process.env.REDIS_URL) {
      const jobQueue = require('./jobQueueService');
      const minuteSlot = Math.floor(Date.now() / MINUTE_IN_MS);
      const organizationId = task.organization_id;
      const orgSuffix = organizationId === undefined || organizationId === null ? '' : `-org${organizationId}`;
      const jobId = `${task.task_name}${orgSuffix}-${minuteSlot}`;
      await jobQueue.add(
        'scheduled-task',
        { taskId: task.id, taskName: task.task_name, organizationId },
        {
          jobId,
          attempts: 2,
          backoff: { type: 'exponential', delay: 5000 },
        },
      ).catch((err) => {
        // jobId collision means another node already enqueued it — normal
        logger.debug({ err: err.message, taskName: task.task_name }, 'Scheduled-task job dedup (normal)');
      });
      return;
    }

    // No Redis: run inline, once across all processes (see runClaimed). The
    // run records its own outcome, a failure included (ASY-28).
    await track(runClaimed(task, async () => {
      try {
        await taskRunner.executeScheduledTask(task, 'cron');
      } catch (err) {
        logger.error({ err, taskName: task.task_name }, 'Scheduled task failed');
      }
    })).catch((err) => {
      logger.error({ err, taskName: task.task_name }, 'Scheduler could not claim the task');
    });
  }, { timezone: businessTimezone() });

  // Keyed by id: per-organization rows share a task_name, and keying by name
  // lost the handle of every row but the last, so stop() left them running.
  jobs.set(task.id, { job, taskName: task.task_name, signature: signature(task) });
}

/**
 * Stop all scheduled cron jobs.
 */
function stop() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  for (const { job } of jobs.values()) {
    job.stop();
  }
  jobs.clear();
  logger.info('Scheduler stopped');
}

/**
 * Return status of all registered jobs.
 */
function getStatus() {
  const result = [];
  for (const [id, { taskName }] of jobs) {
    result.push({ task_id: id, task_name: taskName, scheduled: true });
  }
  return result;
}

module.exports = { start, stop, drain, getStatus, runClaimed, runExclusive, sync, reload };
