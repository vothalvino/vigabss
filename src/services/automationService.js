// =============================================================================
// VigaBSS 5.0 — Automation Service (§18.1)
// =============================================================================
// Handles workflow automation rules, batch subscriber operations, provisioning
// pipelines, and auto-remediation rules.
//
// Rule actions and event triggers live in automationActions.js (ASY-36).
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'automationService' });
const auditLog = require('./auditLog');
const { assertPlanSelectable } = require('./planAvailability');
const { updateContractWithActivationGuard } = require('./contractUpdateGuard');
const contractPlanChangeService = require('./contractPlanChangeService');
const planChangeProrationService = require('./planChangeProrationService');
const { assertOwnedReferences } = require('../utils/ownedReferences');
const { AppError, ValidationError } = require('../utils/errors');
const { parseJsonColumn } = require('../utils/jsonColumn');
const { SNMP_METRICS } = require('./alertService');

// Lazily required to avoid circular deps at module load
let _suspensionService = null;
function getSuspensionService() {
  if (!_suspensionService) _suspensionService = require('./suspensionService');
  return _suspensionService;
}

// ---------------------------------------------------------------------------
// Automation Rules — evaluate a trigger event against all matching rules
// ---------------------------------------------------------------------------

/**
 * Evaluate all enabled automation rules for a given trigger event.
 * Records each execution in automation_rule_executions.
 *
 * @param {number} organizationId
 * @param {string} triggerEvent  e.g. 'invoice.created', 'device.offline'
 * @param {object} payload       Event data for condition matching
 * @param {{ ruleId?: number }} [options]  limit to one rule (a manual run)
 * @returns {{ evaluated: number, triggered: number, results: Array<{ rule_id, status, message }> }}
 */
async function evaluateAutomationRules(organizationId, triggerEvent, payload = {}, { ruleId = null } = {}) {
  const [rules] = await db.query(
    `SELECT * FROM automation_rules
     WHERE organization_id = ? AND trigger_event = ? AND is_enabled = 1
       AND deleted_at IS NULL${ruleId ? ' AND id = ?' : ''}
     ORDER BY priority DESC`,
    ruleId ? [organizationId, triggerEvent, ruleId] : [organizationId, triggerEvent],
  );

  let triggered = 0;
  const results = [];
  for (const rule of rules) {
    const start = Date.now();
    let status = 'success';
    let resultMessage;

    try {
      const conditions = ruleConditions(rule.trigger_conditions);
      const match = conditions.every(c => evaluateCondition(payload, c));
      if (!match) {
        status = 'skipped';
        resultMessage = 'Conditions not met';
      } else {
        const outcome = await dispatchAction(rule.action_type, parseJsonColumn(rule.action_config, {}), payload, organizationId, rule);
        resultMessage = outcome.message;
        if (outcome.status !== 'done') {
          // Nothing was done (not implemented, or nothing to act on), so
          // nothing is recorded as a run (ASY-16).
          status = 'skipped';
        } else {
          triggered++;
          await db.query(
            'UPDATE automation_rules SET run_count = run_count + 1, last_triggered_at = NOW() WHERE id = ?',
            [rule.id],
          );
        }
      }
    } catch (err) {
      status = 'failure';
      resultMessage = err.message;
      logger.error({ err, ruleId: rule.id }, 'Automation rule execution failed');
    }

    await db.query(
      `INSERT INTO automation_rule_executions
         (organization_id, automation_rule_id, trigger_event, trigger_payload, status, result_message, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [organizationId, rule.id, triggerEvent, JSON.stringify(payload), status, resultMessage, Date.now() - start],
    );
    results.push({ rule_id: rule.id, status, message: resultMessage });
  }

  return { evaluated: rules.length, triggered, results };
}

/**
 * trigger_conditions is a JSON array of { field, operator, value }, all of
 * which must hold. A row stored as one condition object is read as a list of
 * one; any other shape means no conditions.
 */
function ruleConditions(raw) {
  const parsed = parseJsonColumn(raw, []);
  if (Array.isArray(parsed)) return parsed;
  return parsed && typeof parsed === 'object' && parsed.field ? [parsed] : [];
}

/**
 * Evaluate a single condition object against a payload.
 * @param {object} payload
 * @param {{ field: string, operator: string, value: * }} condition
 * @returns {boolean}
 */
function evaluateCondition(payload, condition) {
  const { field, operator, value } = condition;
  const actual = field.split('.').reduce((obj, key) => (obj && obj[key] !== undefined ? obj[key] : undefined), payload);
  switch (operator) {
    case 'eq':  return actual === value;
    case 'neq': return actual !== value;
    case 'gt':  return actual > value;
    case 'lt':  return actual < value;
    case 'gte': return actual >= value;
    case 'lte': return actual <= value;
    case 'contains': return String(actual || '').includes(String(value));
    case 'exists': return actual !== undefined && actual !== null;
    default: return false;
  }
}

/**
 * Dispatch an automation rule action (automationActions, ASY-36).
 * @param {string} actionType
 * @param {object} actionConfig
 * @param {object} payload
 * @param {number} organizationId
 * @param {object} [rule]  the rule row (its id and name label what the action does)
 * @returns {Promise<{ status: 'done'|'skipped'|'not_implemented', message: string }>}
 */
async function dispatchAction(actionType, actionConfig, payload, organizationId, rule = {}) {
  return require('./automationActions').runAction(
    { ...rule, action_type: actionType, action_config: actionConfig || {} },
    payload,
    organizationId,
  );
}

// ---------------------------------------------------------------------------
// Batch Jobs — enqueue and process
// ---------------------------------------------------------------------------

// A batch job used to run every item inside the HTTP request, which a CoA per
// contract (up to 5 s each) pushed far past the 30-second request timeout
// (TNA-41). It now persists one item per target and runs in the background
// through jobQueueService; the request answers at once with the pending job.
const MAX_BATCH_TARGETS = 10_000;
const ITEM_CHUNK = 100;

/**
 * Create a batch job: check its parameters, resolve and persist its targets,
 * and queue it. Returns the pending job; progress shows on the job row.
 *
 * @param {number} organizationId
 * @param {{ name, operation, filter_criteria, operation_params, created_by }} data
 */
async function createBatchJob(organizationId, data) {
  const { name, operation, filter_criteria, operation_params, created_by } = data;
  // Operation parameters are checked once, before the job exists: a foreign or
  // archived plan, or another tenant's invoice, used to be applied to every
  // target (ASY-15).
  await checkBatchParams(organizationId, operation, operation_params || {});

  const targets = await resolveBatchTargets(organizationId, operation, filter_criteria || {});

  const [result] = await db.query(
    `INSERT INTO batch_jobs
       (organization_id, name, operation, filter_criteria, operation_params,
        status, total_items, processed_items, success_items, failed_items, created_by)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, 0, 0, ?)`,
    [organizationId, name, operation, JSON.stringify(filter_criteria || {}),
      operation_params ? JSON.stringify(operation_params) : null,
      targets.length, created_by || null],
  );
  const jobId = result.insertId;

  for (let i = 0; i < targets.length; i += 500) {
    const chunk = targets.slice(i, i + 500);
    await db.query(
      `INSERT INTO batch_job_items (batch_job_id, organization_id, entity_type, entity_id, status)
       VALUES ${chunk.map(() => "(?, ?, ?, ?, 'pending')").join(', ')}`,
      chunk.flatMap(t => [jobId, organizationId, t.entity_type, t.entity_id]),
    );
  }

  await queueBatchJob(jobId, organizationId);
  const [rows] = await db.query('SELECT * FROM batch_jobs WHERE id = ? AND organization_id = ?', [jobId, organizationId]);
  return rows[0];
}

async function queueBatchJob(jobId, organizationId) {
  const jobQueue = require('./jobQueueService');
  await jobQueue.add('batch-job', { jobId: Number(jobId), organizationId: Number(organizationId) }, {
    jobId: `batch-job-${jobId}`,
    attempts: 1,
  }).catch((err) => {
    // The row is durable; resumeBatchJobs picks it up at the next start.
    logger.warn({ err: err.message, jobId }, 'Could not queue the batch job; it resumes at the next start');
  });
}

/**
 * Run a batch job's remaining items. Holds the job's advisory lock, so a job
 * queued twice (a resume on two replicas) runs once. An item is claimed as
 * 'processing' before its operation runs; one found still 'processing' (the
 * process stopped mid-item) is recorded as a failure to check by hand rather
 * than run again, because the operation may already have happened.
 */
async function processBatchJob(jobId, organizationId) {
  const { withAdvisoryLock } = require('../utils/advisoryLock');
  return withAdvisoryLock(`batch-job:${jobId}`, async () => {
    const [[job]] = await db.query(
      'SELECT * FROM batch_jobs WHERE id = ? AND organization_id = ?',
      [jobId, organizationId],
    );
    if (!job || !['pending', 'running'].includes(job.status)) return;
    await db.query(
      "UPDATE batch_jobs SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = ? AND status IN ('pending','running')",
      [jobId],
    );
    await db.query(
      `UPDATE batch_job_items SET status = 'failure', processed_at = NOW(),
              result_message = 'Interrupted while running; check this one by hand'
        WHERE batch_job_id = ? AND status = 'processing'`,
      [jobId],
    );
    const params = parseJsonColumn(job.operation_params, {}) || {};

    for (;;) {
      // POST /batch-jobs/:id/cancel flips the status; stop between chunks.
      const [[current]] = await db.query('SELECT status FROM batch_jobs WHERE id = ?', [jobId]);
      if (current?.status !== 'running') break;
      const [items] = await db.query(
        `SELECT id, entity_type, entity_id FROM batch_job_items
          WHERE batch_job_id = ? AND status = 'pending' ORDER BY id LIMIT ${ITEM_CHUNK}`,
        [jobId],
      );
      if (items.length === 0) break;
      for (const item of items) {
        const [claim] = await db.query(
          "UPDATE batch_job_items SET status = 'processing' WHERE id = ? AND status = 'pending'",
          [item.id],
        );
        if (Number(claim.affectedRows) !== 1) continue;
        let status = 'success';
        let message = `${job.operation} applied`;
        try {
          const outcome = await applyBatchOperation(organizationId, job.operation, item, params, job.created_by || null);
          if (outcome && outcome.skipped) {
            status = 'skipped';
            message = String(outcome.message).slice(0, 500);
          } else if (outcome && outcome.message) {
            message = String(outcome.message).slice(0, 500);
          }
        } catch (err) {
          status = 'failure';
          message = String(err.message).slice(0, 500);
        }
        await db.query(
          'UPDATE batch_job_items SET status = ?, result_message = ?, processed_at = NOW() WHERE id = ?',
          [status, message, item.id],
        );
      }
      await refreshBatchCounts(jobId);
    }

    await refreshBatchCounts(jobId);
    // A cancelled job keeps its status; only a job still running completes.
    await db.query(
      "UPDATE batch_jobs SET status = 'completed', completed_at = NOW() WHERE id = ? AND status = 'running'",
      [jobId],
    );
  });
}

async function refreshBatchCounts(jobId) {
  await db.query(
    `UPDATE batch_jobs bj
        JOIN (SELECT SUM(status IN ('success','failure','skipped')) AS processed,
                     SUM(status = 'success') AS ok,
                     SUM(status = 'failure') AS failed
                FROM batch_job_items WHERE batch_job_id = ?) counts
        SET bj.processed_items = COALESCE(counts.processed, 0),
            bj.success_items = COALESCE(counts.ok, 0),
            bj.failed_items = COALESCE(counts.failed, 0)
      WHERE bj.id = ?`,
    [jobId, jobId],
  );
}

/**
 * Queue every unfinished batch job again: the in-process queue (no Redis)
 * loses its jobs on a restart. Called at startup; the job lock keeps a job
 * queued by several replicas from running twice.
 * @returns {Promise<number>} jobs queued
 */
async function resumeBatchJobs() {
  let count = 0;
  // The primary and every isolated organization's database.
  await require('./organizationFanOut').forEachDatabaseScope('resume_batch_jobs', async (scopeOrgId) => {
    const { sql, params } = require('./organizationFanOut').orgScopeFilter('organization_id', scopeOrgId);
    const [rows] = await db.query(
      `SELECT id, organization_id FROM batch_jobs WHERE status IN ('pending','running')${sql}`,
      params,
    );
    for (const row of rows) await queueBatchJob(row.id, row.organization_id);
    count += rows.length;
  });
  if (count) logger.info({ count }, 'Resumed unfinished batch jobs');
  return count;
}

// Operations with no implementation are refused before a job exists, rather
// than failing every item (ASY-36).
const BATCH_NOT_IMPLEMENTED = Object.freeze(['rate_limit', 'send_notification', 'apply_tag', 'remove_tag']);
const BATCH_MESSAGE_CLASSES = Object.freeze(['transactional', 'marketing']);

async function checkBatchParams(organizationId, operation, params) {
  if (BATCH_NOT_IMPLEMENTED.includes(operation)) {
    throw new AppError(
      `Batch operation '${operation}' is not implemented; nothing was queued.`
        + (operation === 'send_notification' ? ' Use send_email or send_sms.' : ''),
      501,
      'BATCH_OPERATION_NOT_IMPLEMENTED',
    );
  }
  if (operation === 'send_email' || operation === 'send_sms') {
    if (typeof params.message !== 'string' || !params.message.trim()) {
      throw new ValidationError(`${operation} requires operation_params.message`);
    }
    if (operation === 'send_email' && (typeof params.subject !== 'string' || !params.subject.trim())) {
      throw new ValidationError('send_email requires operation_params.subject');
    }
    if (params.message_class !== undefined && !BATCH_MESSAGE_CLASSES.includes(params.message_class)) {
      throw new ValidationError(`operation_params.message_class must be one of: ${BATCH_MESSAGE_CLASSES.join(', ')}`);
    }
  }
  if (operation === 'change_plan') {
    if (!params.plan_id) throw new ValidationError('change_plan requires operation_params.plan_id');
    if (params.prorate !== undefined && typeof params.prorate !== 'boolean') {
      throw new ValidationError('operation_params.prorate must be true or false');
    }
    await assertPlanSelectable(db, params.plan_id, organizationId);
  }
  if (operation === 'suspend' || operation === 'unsuspend') {
    await assertOwnedReferences(params, organizationId, { invoice_id: 'invoices' });
  }
  return params;
}

async function resolveBatchTargets(organizationId, operation, filterCriteria) {
  // An explicit list (POST /bulk/suspend): one item per id, so an id that is
  // not this organization's contract is reported on its own item.
  if (Array.isArray(filterCriteria.contract_ids)) {
    const ids = [...new Set(filterCriteria.contract_ids.map(Number))];
    if (ids.length === 0 || ids.some(n => !Number.isSafeInteger(n) || n <= 0)) {
      throw new ValidationError('contract_ids must be positive contract ids');
    }
    if (ids.length > MAX_BATCH_TARGETS) throw new ValidationError(`At most ${MAX_BATCH_TARGETS} contracts per job`);
    return ids.map(id => ({ entity_id: id, entity_type: 'contract' }));
  }

  // Build a simple contract/client list from filter_criteria
  const conditions = ['c.organization_id = ?'];
  const params = [organizationId];

  if (filterCriteria.status) {
    conditions.push('c.status = ?');
    params.push(filterCriteria.status);
  }
  if (filterCriteria.plan_id) {
    conditions.push('c.plan_id = ?');
    params.push(filterCriteria.plan_id);
  }
  if (filterCriteria.client_id) {
    conditions.push('c.client_id = ?');
    params.push(filterCriteria.client_id);
  }


  // Every match runs; more than the cap is refused rather than cut short
  // (the old LIMIT 1000 dropped the rest without a word).
  const [rows] = await db.query(
    `SELECT id AS entity_id, 'contract' AS entity_type FROM contracts c
      WHERE ${conditions.join(' AND ')} ORDER BY c.id LIMIT ${MAX_BATCH_TARGETS + 1}`,
    params,
  );
  if (rows.length > MAX_BATCH_TARGETS) {
    throw new ValidationError(`The filter matches more than ${MAX_BATCH_TARGETS} contracts; narrow it and run several jobs`);
  }
  return rows;
}

/**
 * Apply a single batch operation to one target entity.
 *
 * IMPLEMENTED for safe contract-level operations that use existing services:
 *   suspend    → suspensionService.suspendContract()
 *   unsuspend  → suspensionService.reconnectContract()
 *   change_plan → the contract update guard, then FreeRADIUS + CoA (pushPlanChange)
 *   send_email / send_sms → one message_outbox row per item for the contract's
 *     client (dedupe key per item, so a resumed job never sends twice); a
 *     message the client's preferences block is a 'skipped' item
 *
 * NOT IMPLEMENTED (refused by checkBatchParams; throws if reached):
 *   rate_limit, send_notification, apply_tag, remove_tag
 *
 * @returns {Promise<void|{skipped?: boolean, message?: string}>}
 */
async function applyBatchOperation(organizationId, operation, target, params, actorId = null) {
  const contractId = target.entity_id;

  switch (operation) {
    case 'suspend': {
      // Only suspend contracts belonging to this org
      const [rows] = await db.query(
        'SELECT id, status FROM contracts WHERE id = ? AND organization_id = ?',
        [contractId, organizationId],
      );
      if (!rows.length) {
        throw new Error(`Contract ${contractId} not found in organization`);
      }
      // Only an active contract can be suspended (the contract status FSM
      // trigger allows active -> suspended only); say so instead of passing
      // on the trigger's raw SQLSTATE 45000.
      if (rows[0].status !== 'active') {
        throw new Error(`Cannot suspend a '${rows[0].status}' contract`);
      }
      const suspSvc = getSuspensionService();
      // An operator batch, not a rule run: the actor is the job's creator, and
      // a body rule_id/user_id only forged the suspension log's attribution.
      const outcome = await suspSvc.suspendContract(contractId, null, actorId, params.invoice_id || null);
      // An exempt client is skipped by suspendContract, which is not a success.
      if (outcome && outcome.skipped) {
        throw new Error(`Suspension-exempt client: ${outcome.reason || 'exempt'}`);
      }
      logger.info({ organizationId, contractId, operation }, 'Batch suspend applied');
      return;
    }

    case 'unsuspend': {
      const [rows] = await db.query(
        `SELECT id, status, first_activated_at FROM contracts
          WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
        [contractId, organizationId],
      );
      if (!rows.length) {
        throw new Error(`Contract ${contractId} not found in organization`);
      }
      if (rows[0].status !== 'suspended' || !rows[0].first_activated_at) {
        throw new Error(
          `Contract ${contractId} must be suspended and previously activated before batch unsuspend`,
        );
      }
      const suspSvc = getSuspensionService();
      await suspSvc.reconnectContract(
        contractId,
        actorId,
        params.invoice_id || null,
        { orgId: organizationId },
      );
      logger.info({ organizationId, contractId, operation }, 'Batch unsuspend applied');
      return;
    }

    case 'change_plan': {
      if (!params.plan_id) {
        throw new Error('change_plan requires operation_params.plan_id');
      }
      const [rows] = await db.query(
        'SELECT * FROM contracts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
        [contractId, organizationId],
      );
      if (!rows.length) {
        throw new Error(`Contract ${contractId} not found in organization`);
      }
      if (Number(rows[0].plan_id) === Number(params.plan_id)) {
        return { skipped: true, message: 'Already on this plan' };
      }
      // The PUT /contracts/:id path (ASY-15): refused while an installation is
      // prepared, the rest of an invoiced period billed at the new price
      // (operation_params.prorate: false skips it), then put on the network
      // rather than only stored.
      const conn = await db.getConnection();
      let proration = null;
      try {
        await conn.beginTransaction();
        await updateContractWithActivationGuard(rows[0], { plan_id: params.plan_id }, organizationId, conn);
        if (params.prorate !== false) {
          proration = await planChangeProrationService.prorate(conn, {
            contract: rows[0], newPlanId: params.plan_id, organizationId, actorId,
          });
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
      if (proration?.invoice) await require('./businessEvents').emitInvoiceCreated(organizationId, proration.invoice);
      const network = await contractPlanChangeService.pushPlanChange(contractId, organizationId);
      await auditLog.log({
        userId: actorId, organizationId, action: 'update', tableName: 'contracts', recordId: contractId,
        oldValues: { plan_id: rows[0].plan_id },
        newValues: { plan_id: params.plan_id, coa_sent: Boolean(network.coa_sent), proration_net: proration?.net ?? 0 },
      });
      logger.info({ organizationId, contractId, planId: params.plan_id, operation, network }, 'Batch plan change applied');
      return;
    }

    case 'send_email':
    case 'send_sms':
      return sendBatchMessage(organizationId, operation, target, params);

    default: {
      // Not implemented — throw so createBatchJob records this item as 'failure'
      // and the operator knows the operation did not execute.
      const err = new Error(
        `Batch operation '${operation}' is not implemented — target ${target.entity_type}:${contractId} was NOT modified`,
      );
      err.code = 'BATCH_OPERATION_NOT_IMPLEMENTED';
      logger.warn({ organizationId, operation, target, params }, err.message);
      throw err;
    }
  }
}

async function sendBatchMessage(organizationId, operation, target, params) {
  const [[row]] = await db.query(
    `SELECT c.id AS contract_id, cl.id AS client_id, cl.name, cl.email, cl.phone
       FROM contracts c
       JOIN clients cl ON cl.id = c.client_id AND cl.organization_id = c.organization_id AND cl.deleted_at IS NULL
      WHERE c.id = ? AND c.organization_id = ? AND c.deleted_at IS NULL`,
    [target.entity_id, organizationId],
  );
  if (!row) throw new Error(`Contract ${target.entity_id} not found in organization`);
  const channel = operation === 'send_email' ? 'email' : 'sms';
  const recipient = channel === 'email' ? row.email : row.phone;
  if (!recipient) {
    return { skipped: true, message: `Client #${row.client_id} has no ${channel === 'email' ? 'email address' : 'phone number'}` };
  }
  const { fill } = require('./automationActions');
  const context = { client: { id: row.client_id, name: row.name }, contract: { id: row.contract_id } };
  const body = fill(params.message, context).trim();
  const queued = await require('./messageOutbox').enqueue({
    channel,
    organizationId,
    clientId: row.client_id,
    messageClass: BATCH_MESSAGE_CLASSES.includes(params.message_class) ? params.message_class : 'transactional',
    recipient,
    ...(channel === 'email'
      ? {
        subject: fill(params.subject, context).trim(),
        bodyText: body,
        bodyHtml: `<p>${require('./notificationService').escapeHtmlForTemplate(body)}</p>`,
      }
      : { bodyText: body }),
    sourceType: 'batch_job_item',
    sourceId: target.id ?? null,
    // One message per item, even when an interrupted job is resumed.
    dedupeKey: target.id ? `batch_job_item:${organizationId}:${target.id}` : null,
  });
  if (!queued.queued) return { skipped: true, message: `Not sent: ${queued.code || 'blocked by the client\'s communication preferences'}` };
  return { message: `${channel === 'email' ? 'Email' : 'SMS'} queued (outbox #${queued.id})` };
}

// ---------------------------------------------------------------------------
// Provisioning Pipelines
// ---------------------------------------------------------------------------

const DEFAULT_STAGES = ['assign_ip', 'configure_device', 'activate_contract', 'send_notification'];

/**
 * Run a provisioning pipeline for a contract.
 * Stages are ordered; 'configure_device' is STUBBED (no live device call).
 */
async function runProvisioningPipeline(organizationId, { name, contract_id, client_id, ip_pool_id = null, triggered_by }) {
  const [result] = await db.query(
    `INSERT INTO provisioning_pipelines
       (organization_id, name, contract_id, client_id, status, current_stage, stages_config, triggered_by, started_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, NOW())`,
    [organizationId, name, contract_id || null, client_id || null,
      DEFAULT_STAGES[0], JSON.stringify(DEFAULT_STAGES), triggered_by || null],
  );
  const pipelineId = result.insertId;
  const stageResults = {};
  let pipelineStatus = 'completed';
  let errorMessage = null;

  for (let i = 0; i < DEFAULT_STAGES.length; i++) {
    const stageName = DEFAULT_STAGES[i];
    const stageStart = Date.now();
    let stageStatus = 'completed';
    let stageOutput = null;
    let stageError = null;

    await db.query(
      'UPDATE provisioning_pipelines SET current_stage = ? WHERE id = ?',
      [stageName, pipelineId],
    );

    await db.query(
      `INSERT INTO provisioning_pipeline_stages
         (pipeline_id, organization_id, stage_order, stage_name, status, started_at)
       VALUES (?, ?, ?, ?, 'running', NOW())`,
      [pipelineId, organizationId, i, stageName],
    );

    try {
      stageOutput = await executeProvisioningStage(stageName, { organizationId, contract_id, client_id, ip_pool_id });
      // A stage with no implementation, or nothing to do, did nothing:
      // 'skipped', never 'completed' (TNB-37).
      if (stageOutput && (stageOutput.implemented === false || stageOutput.skipped)) stageStatus = 'skipped';
    } catch (err) {
      stageStatus = 'failed';
      stageError = err.message;
      pipelineStatus = 'failed';
      errorMessage = `Stage '${stageName}' failed: ${err.message}`;
    }

    const duration = Date.now() - stageStart;
    stageResults[stageName] = { status: stageStatus, output: stageOutput, error: stageError, duration_ms: duration };

    await db.query(
      `UPDATE provisioning_pipeline_stages
       SET status = ?, output_data = ?, error_message = ?, completed_at = NOW()
       WHERE pipeline_id = ? AND stage_name = ?`,
      [stageStatus, JSON.stringify(stageOutput), stageError, pipelineId, stageName],
    );

    if (pipelineStatus === 'failed') break;
  }

  // A run in which no stage did any work provisioned nothing; reporting it
  // 'completed' told staff the subscriber was set up.
  const skipped = Object.entries(stageResults).filter(([, r]) => r.status === 'skipped').map(([n]) => n);
  if (pipelineStatus === 'completed' && skipped.length > 0) {
    const didWork = Object.values(stageResults).some(r => r.status === 'completed' && r.output?.implemented !== false
      && !r.output?.skipped && !(r.output && r.output.activated === false));
    if (!didWork) {
      pipelineStatus = 'failed';
      errorMessage = `Nothing was provisioned: stages not implemented (${skipped.join(', ')})`;
    }
  }

  await db.query(
    `UPDATE provisioning_pipelines
     SET status = ?, stages_results = ?, completed_at = NOW(), error_message = ?
     WHERE id = ?`,
    [pipelineStatus, JSON.stringify(stageResults), errorMessage, pipelineId],
  );

  const [rows] = await db.query('SELECT * FROM provisioning_pipelines WHERE id = ?', [pipelineId]);
  return rows[0];
}

async function executeProvisioningStage(stageName, ctx) {
  switch (stageName) {
    case 'assign_ip':
      // It reported a "completed" stage with assigned_ip 0.0.0.0 (TNB-37);
      // it now allocates through poolAssignmentService (ASY-36).
      return assignPipelineIp(ctx);
    case 'configure_device':
      // Not implemented: live device configuration (routerDriverService integration) is
      // not wired. Do NOT claim success and do NOT abort the whole pipeline — record an
      // explicit not-implemented marker so the stage output truthfully shows that no
      // device I/O happened, while the remaining implemented stages (activate_contract,
      // send_notification) still run. This avoids both false "device configured" success
      // and a pipeline that can never complete.
      logger.warn(ctx, 'Provisioning: configure_device not implemented — recording stage as not-implemented (no device I/O performed)');
      return {
        implemented: false,
        note: 'configure_device not implemented — no device I/O performed. Configure the device manually or wire routerDriverService to enable automated provisioning.',
      };
    case 'activate_contract':
      if (ctx.contract_id) {
        // First activation is an evidence-bearing customer lifecycle action,
        // not a provisioning-pipeline toggle. The old raw UPDATE bypassed the
        // installation work order, measured technician speed test, bounded
        // line shutdown, MX client signature, acceptance, billing, RADIUS
        // restoration, and audit trail. Stop this pipeline honestly and send
        // the operator to the contract's guided activation flow.
        const err = new Error(
          `Contract ${ctx.contract_id} was not activated: complete the guided activation flow on the contract page`,
        );
        err.code = 'CONTRACT_ACTIVATION_FLOW_REQUIRED';
        throw err;
      }
      return { contract_id: null, activated: false, note: 'No contract was supplied for activation' };
    case 'send_notification':
      // Not implemented: it claimed "Notification dispatched" without sending
      // anything (TNB-37).
      logger.warn(ctx, 'Provisioning: send_notification not implemented — nothing sent');
      return { implemented: false, note: 'send_notification not implemented — no notification was sent.' };
    default:
      return { implemented: false, note: `Unknown stage: ${stageName}` };
  }
}

/**
 * assign_ip: keep the contract's active address, or take the next free one
 * from the chosen pool (the pool and contract are checked against the
 * organization by assignNextFreeIp, the same path as POST /ip-pools/:id/assign-next).
 */
async function assignPipelineIp({ organizationId, contract_id, ip_pool_id }) {
  if (!contract_id) return { skipped: true, note: 'No contract was supplied; no address was assigned' };
  const [[contract]] = await db.query(
    'SELECT id, client_id FROM contracts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [contract_id, organizationId],
  );
  if (!contract) throw new ValidationError('contract_id does not belong to this organization');
  const [[existing]] = await db.query(
    `SELECT ip_address, pool_id FROM ip_assignments
      WHERE contract_id = ? AND organization_id = ? AND status = 'active' AND deleted_at IS NULL
      ORDER BY id LIMIT 1`,
    [contract.id, organizationId],
  );
  if (existing) return { assigned_ip: existing.ip_address, pool_id: existing.pool_id, reused: true };
  if (!ip_pool_id) {
    return { skipped: true, note: 'No address was assigned: the contract has none and no ip_pool_id was given' };
  }
  const assignment = await require('./poolAssignmentService').assignNextFreeIp(ip_pool_id, {
    contractId: contract.id, clientId: contract.client_id, orgId: organizationId,
  });
  logger.info({ organizationId, contractId: contract.id, ip: assignment.ip_address }, 'Provisioning: address assigned');
  return { assigned_ip: assignment.ip_address, pool_id: assignment.pool_id, assignment_id: assignment.id };
}

// ---------------------------------------------------------------------------
// Remediation Rules — evaluate and dispatch
// ---------------------------------------------------------------------------

/**
 * Evaluate all enabled remediation rules for an organization.
 * Records each execution; a reboot goes to the breaching device's driver.
 */
async function evaluateRemediationRules(organizationId) {
  const [rules] = await db.query(
    `SELECT * FROM remediation_rules
     WHERE organization_id = ? AND is_enabled = 1 AND deleted_at IS NULL`,
    [organizationId],
  );

  let triggered = 0;
  const now = new Date();

  for (const rule of rules) {
    // Enforce cooldown
    if (rule.last_triggered_at) {
      const lastMs = new Date(rule.last_triggered_at).getTime();
      const cooldownMs = (rule.cooldown_minutes || 30) * 60 * 1000;
      if (now.getTime() - lastMs < cooldownMs) continue;
    }

    const { triggered: conditionMet, deviceId } = await checkRemediationCondition(organizationId, rule);
    if (!conditionMet) continue;

    const start = Date.now();
    const { status: execStatus, message: resultMessage } = await dispatchRemediation(organizationId, rule, deviceId);

    await db.query(
      `INSERT INTO remediation_executions
         (organization_id, remediation_rule_id, device_id, action_type, status, result_message, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [organizationId, rule.id, deviceId, rule.action_type, execStatus, resultMessage, Date.now() - start],
    );

    await db.query(
      'UPDATE remediation_rules SET run_count = run_count + 1, last_triggered_at = NOW() WHERE id = ?',
      [rule.id],
    );
    triggered++;
  }

  return { evaluated: rules.length, triggered };
}

/** Remediation action_type → driver command. Only these reach a device. */
const REMEDIATION_COMMANDS = Object.freeze({ reboot: 'reboot', reboot_device: 'reboot' });

/**
 * Run a remediation rule's action on the breaching device through its vendor
 * driver (routerDriverService, NET-30). An action with no driver command, or
 * a device with no driver config that implements it, is 'not_dispatched'.
 * @returns {Promise<{ status: 'success'|'failure'|'not_dispatched', message: string }>}
 */
async function dispatchRemediation(organizationId, rule, deviceId) {
  const command = REMEDIATION_COMMANDS[rule.action_type];
  if (!command) {
    return { status: 'not_dispatched', message: `Action '${rule.action_type}' was NOT dispatched — only reboot can be sent to a device` };
  }
  if (!deviceId) return { status: 'not_dispatched', message: 'No device breached the condition' };
  try {
    const config = await require('./apCommandService').driverConfigFor(deviceId, organizationId, command);
    if (!config) {
      return { status: 'not_dispatched', message: `Device #${deviceId} has no active driver config that can ${command}; nothing was sent` };
    }
    const result = await require('./routerDriverService').dispatchCommand(config.id, organizationId, command, {}, null);
    if (result && result.status === 'success') {
      return { status: 'success', message: `${command} sent to device #${deviceId} (driver execution #${result.execution_id})` };
    }
    return { status: 'failure', message: String(result?.error_message || 'The device did not accept the command').slice(0, 500) };
  } catch (err) {
    return { status: 'failure', message: String(err.message).slice(0, 500) };
  }
}

/**
 * @param {number|string} organizationId
 * @param {object} rule - a remediation_rules row
 * @returns {Promise<{triggered: boolean, deviceId: number|null}>}
 */
async function checkRemediationCondition(organizationId, rule) {
  // snmp_metrics is a WIDE table (one column per metric: cpu_usage,
  // memory_usage, signal_strength, …) — there is no generic `metric`/`value`
  // pair column, so `rule.condition_metric` names WHICH COLUMN to read, not a
  // row to filter on. `condition_metric` is an admin-supplied free-form
  // string (remediationRules.js validates only length, not content) so it
  // MUST be checked against the same fixed whitelist alertService.js uses
  // before being interpolated into a backtick-quoted identifier — never
  // build a dynamic column reference from unvalidated input.
  if (!SNMP_METRICS.has(rule.condition_metric)) {
    logger.warn({ organizationId, metric: rule.condition_metric }, 'Remediation rule references an unknown/disallowed metric column');
    return { triggered: false, deviceId: null };
  }

  // HIGH — item 4 of the second adversarial review: this used to pick ONE
  // arbitrary device org-wide (no device filter, no recency bound, `LIMIT
  // 1`) and let it decide the WHOLE org. A single device's spike fired an
  // org-wide action and started a cooldown that then suppressed a real
  // breach on a DIFFERENT device; a NULL reading on that one arbitrary
  // device silently read as "no breach" even while every other device in
  // the org was over threshold; `condition_duration_minutes` was never
  // consulted at all.
  //
  // Evaluate every device with a recent reading instead (remediation_rules
  // has no device_id of its own — it is genuinely org-wide by design, but
  // "org-wide" must mean "any device", not "one arbitrary device"), and when
  // condition_duration_minutes is set, require the breach to have held for
  // the WHOLE window (every reading in it breaches), not just the latest
  // instant. `remediation_executions.device_id` records which device
  // actually triggered it.
  const windowMinutes = Math.max(15, Number(rule.condition_duration_minutes) || 0);
  const [rows] = await db.query(
    `SELECT m.device_id, m.\`${rule.condition_metric}\` AS metric_value, m.polled_at
       FROM snmp_metrics m
       JOIN devices d ON d.id = m.device_id
      WHERE d.organization_id = ? AND m.polled_at >= NOW() - INTERVAL ? MINUTE
      ORDER BY m.device_id ASC, m.polled_at DESC`,
    [organizationId, windowMinutes],
  );

  const threshold = rule.condition_threshold !== null ? parseFloat(rule.condition_threshold) : null;
  const breaches = (rawValue) => {
    if (rawValue === null || rawValue === undefined) return false;
    const val = parseFloat(rawValue);
    if (Number.isNaN(val)) return false;
    switch (rule.condition_operator) {
      case 'gt':      return threshold !== null && val > threshold;
      case 'lt':      return threshold !== null && val < threshold;
      case 'gte':     return threshold !== null && val >= threshold;
      case 'lte':     return threshold !== null && val <= threshold;
      case 'eq':      return threshold !== null && val === threshold;
      case 'neq':     return threshold !== null && val !== threshold;
      case 'is_true': return Boolean(val);
      default:        return false;
    }
  };

  const byDevice = new Map();
  for (const row of rows) {
    if (!byDevice.has(row.device_id)) byDevice.set(row.device_id, []);
    byDevice.get(row.device_id).push(row); // already ordered newest-first per device
  }

  const durationMs = (Number(rule.condition_duration_minutes) || 0) * 60 * 1000;

  for (const [deviceId, readings] of byDevice) {
    const latest = readings[0];
    if (!breaches(latest.metric_value)) continue; // this device is not currently breaching

    if (durationMs > 0) {
      const windowStart = new Date(latest.polled_at).getTime() - durationMs;
      const withinWindow = readings.filter((r) => new Date(r.polled_at).getTime() >= windowStart);
      const sustained = withinWindow.length > 0 && withinWindow.every((r) => breaches(r.metric_value));
      if (!sustained) continue; // spike, not a sustained breach — don't trigger yet
    }

    return { triggered: true, deviceId };
  }

  return { triggered: false, deviceId: null };
}

module.exports = {
  evaluateAutomationRules,
  evaluateCondition,
  dispatchAction,
  applyBatchOperation,
  createBatchJob,
  processBatchJob,
  resumeBatchJobs,
  runProvisioningPipeline,
  evaluateRemediationRules,
};
