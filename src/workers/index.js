// =============================================================================
// VigaBSS 5.0 — BullMQ Worker Registry
// =============================================================================
// Registers handlers for all named job queues. When REDIS_URL is set the
// handlers are backed by BullMQ Workers; otherwise the InProcessQueue fallback
// handles them in the same process without any external dependency.
//
// Call registerWorkers() once at server startup (before accepting traffic).
// Call close() on graceful shutdown (handled via jobQueueService.close()).
// =============================================================================

const jobQueue = require('../services/jobQueueService');
const logger = require('../utils/logger').child({ service: 'workers' });

let registered = false;

/**
 * Register all job handlers.  Idempotent — safe to call multiple times.
 */
function registerWorkers() {
  if (registered) return;
  registered = true;

  // Lazy-require each service to break any potential startup-time circular deps.

  // ---- Generic scheduled-task dispatcher ----------------------------------
  jobQueue.process('scheduled-task', async (job) => {
    const taskRunner = require('../services/taskRunner');
    const { taskId, taskName, organizationId = null } = job.data;
    // A job enqueued before its row was disabled or deleted must not run
    // (ASY-18). Jobs without a task id (older producers) run as before.
    if (taskId) {
      const db = require('../config/database');
      const lookup = () => db.query('SELECT is_enabled FROM scheduled_tasks WHERE id = ? LIMIT 1', [taskId]);
      const [rows] = await (typeof db.withPrimaryContext === 'function' ? db.withPrimaryContext(lookup) : lookup());
      if (!rows.length || !rows[0].is_enabled) {
        logger.info({ taskId, taskName }, 'Worker: scheduled task disabled or deleted; skipping');
        return { skipped: true, reason: 'task disabled or deleted' };
      }
    }
    if (!taskId) {
      logger.info({ taskName, organizationId }, 'Worker: running scheduled task');
      const result = await taskRunner.runTask(taskName, organizationId);
      await taskRunner.markTaskRun(taskName, result, { organizationId }).catch(() => {});
      return result;
    }
    // One job per cron minute, but a run that outlasts its interval would
    // overlap the next one across the worker's concurrency. The task's
    // advisory lock (shared with the inline path) refuses the overlap, which
    // is recorded as skipped. A throw is recorded as failed (ASY-28).
    const task = { id: taskId, task_name: taskName, organization_id: organizationId };
    const scheduler = require('../services/scheduler');
    let result;
    const startedAt = new Date();
    const ran = await scheduler.runExclusive(task, async () => {
      logger.info({ taskId, taskName, organizationId }, 'Worker: running scheduled task');
      result = await taskRunner.executeScheduledTask(task, 'worker');
    });
    if (!ran) {
      logger.warn({ taskId, taskName }, 'Worker: previous run still in progress; skipping this one');
      await taskRunner.recordTaskRun(task, {
        status: 'skipped', startedAt, durationMs: 0, error: 'Previous run still in progress', via: 'worker', updateTask: false,
      }).catch(() => {});
      return { skipped: true, reason: 'already_running' };
    }
    return result;
  });

  // ---- Webhook delivery ---------------------------------------------------
  jobQueue.process('webhook-delivery', async (job) => {
    const webhookService = require('../services/webhookService');
    const db = require('../config/database');
    const organizationId = Number(job.data?.organizationId);
    const run = () => webhookService.deliverForWorker(job);
    return Number.isSafeInteger(organizationId) && organizationId > 0
      && typeof db.withTenantContext === 'function'
      ? db.withTenantContext(organizationId, run)
      : run();
  });

  // ---- SNMP trap forwarding delivery ------------------------------------
  // The delivery row already exists before this job is queued. If the queue
  // loses the job, the scheduled retry sweep finds the durable pending row.
  jobQueue.process('trap-forwarding-delivery', async (job) => {
    const trapForwardingService = require('../services/trapForwardingService');
    const db = require('../config/database');
    const { deliveryId, organizationId } = job.data;
    const run = () => trapForwardingService.attemptDelivery(deliveryId, organizationId);
    return typeof db.withPrimaryContext === 'function'
      ? db.withPrimaryContext(run)
      : run();
  });

  // ---- Message outbox -----------------------------------------------------
  // The row is durable before the job exists; a lost job is delivered by the
  // message_outbox sweep instead.
  jobQueue.process('message-outbox', async (job) => {
    const messageOutbox = require('../services/messageOutbox');
    const { id, organizationId = null } = job.data;
    return messageOutbox.deliverNow(id, organizationId);
  });

  // ---- Batch jobs (TNA-41) ------------------------------------------------
  // The items are durable before the job is queued; an unfinished job is
  // queued again at the next start (automationService.resumeBatchJobs).
  jobQueue.process('batch-job', async (job) => {
    const automationService = require('../services/automationService');
    const db = require('../config/database');
    const { jobId, organizationId } = job.data;
    const run = () => automationService.processBatchJob(jobId, organizationId);
    return typeof db.withTenantContext === 'function' ? db.withTenantContext(organizationId, run) : run();
  });

  // ---- AI triage ----------------------------------------------------------
  jobQueue.process('ai-triage', async (job) => {
    const aiReplyService = require('../services/aiReplyService');
    const { orgId, ticketId, channel, inboundText, contractId } = job.data;
    logger.info({ orgId, ticketId, channel }, 'Worker: running AI triage');
    return aiReplyService.generate({ orgId, ticketId, channel, inboundText, contractId });
  });


  logger.info('Job workers registered');
}

/**
 * Reset registration state.  Used in tests to allow re-registration.
 */
function _resetForTesting() {
  registered = false;
}

module.exports = { registerWorkers, _resetForTesting };
