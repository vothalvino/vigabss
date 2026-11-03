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
    logger.info({ taskId, taskName, organizationId }, 'Worker: running scheduled task');
    const result = await taskRunner.runTask(taskName, organizationId);
    await taskRunner.markTaskRun(taskName, result, { taskId, organizationId }).catch(() => {});
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

  // ---- SMS send -----------------------------------------------------------
  jobQueue.process('sms-send', async (job) => {
    const smsTransport = require('../services/smsTransport');
    const { logId, organizationId = null } = job.data;
    logger.debug({ logId }, 'Worker: processing SMS');
    return smsTransport.deliverQueuedLog(logId, organizationId);
  });

  // ---- Message outbox -----------------------------------------------------
  // The row is durable before the job exists; a lost job is delivered by the
  // message_outbox sweep instead.
  jobQueue.process('message-outbox', async (job) => {
    const messageOutbox = require('../services/messageOutbox');
    const { id, organizationId = null } = job.data;
    return messageOutbox.deliverNow(id, organizationId);
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
