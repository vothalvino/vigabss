// =============================================================================
// VigaBSS — AP command execution (NET-26)
// =============================================================================
// POST /wireless/ap-commands stored a 'pending' ap_command_jobs row and
// nothing ever executed it: a reboot queued from the UI never happened, and
// the job stayed pending for good. Now:
//
//   - reboot runs through the device's vendor driver (routerDriverService,
//     NET-30), from a durable row plus a queued 'ap-command' job; the row ends
//     'completed' or 'failed' with the device's answer;
//   - set_tx_power, set_frequency, set_channel_width and other have no radio
//     driver: the request is refused with 501 and nothing is stored;
//   - a device with no driver that can reboot it is refused with 422;
//   - a future scheduled_at is refused with 501: nothing runs scheduled jobs.
//
// A job found 'in_progress' at start-up was interrupted mid-command. It is
// marked failed rather than sent again: the reboot may already have happened.
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'apCommandService' });
const { AppError, NotFoundError, ValidationError } = require('../utils/errors');
const { getDriver } = require('./drivers');

/** command_type → driver command. Only these can be executed. */
const EXECUTABLE = { reboot: 'reboot' };

/** The device's active driver config whose driver implements the command. */
async function driverConfigFor(deviceId, orgId, driverCommand) {
  const [configs] = await db.query(
    `SELECT id, vendor FROM router_driver_configs
      WHERE device_id = ? AND organization_id = ? AND is_active = 1 AND deleted_at IS NULL
      ORDER BY id DESC`,
    [deviceId, orgId],
  );
  return configs.find((c) => {
    const driver = getDriver(c.vendor);
    return driver && Object.prototype.hasOwnProperty.call(driver.commands, driverCommand);
  }) || null;
}

async function queueApCommand(jobId, organizationId) {
  const jobQueue = require('./jobQueueService');
  await jobQueue.add('ap-command', { jobId: Number(jobId), organizationId: Number(organizationId) }, {
    jobId: `ap-command-${jobId}`,
    attempts: 1,
  }).catch((err) => {
    // The row is durable; resumeApCommands picks it up at the next start.
    logger.warn({ err: err.message, jobId }, 'Could not queue the AP command; it resumes at the next start');
  });
}

/**
 * Validate and store an AP command, then queue it.
 * @returns {Promise<object>} the stored job
 */
async function createApCommandJob(orgId, userId, data) {
  const driverCommand = EXECUTABLE[data.command_type];
  if (!driverCommand) {
    throw new AppError(
      `'${data.command_type}' AP commands are not implemented: no radio driver can apply them, so nothing was queued.`,
      501,
      'AP_COMMAND_NOT_IMPLEMENTED',
    );
  }
  if (data.scheduled_at) {
    const at = new Date(data.scheduled_at);
    if (Number.isNaN(at.getTime())) throw new ValidationError('scheduled_at is not a date');
    if (at.getTime() > Date.now() + 60 * 1000) {
      throw new AppError(
        'Scheduled AP commands are not run yet; leave scheduled_at empty to run the command now.',
        501,
        'AP_COMMAND_SCHEDULE_NOT_IMPLEMENTED',
      );
    }
  }

  const [devices] = await db.query(
    'SELECT id FROM devices WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [data.device_id, orgId],
  );
  if (!devices.length) throw new NotFoundError('Device');
  if (!await driverConfigFor(data.device_id, orgId, driverCommand)) {
    throw new ValidationError(
      'This device has no active router driver config that can run this command; add one (e.g. MikroTik RouterOS API) first',
    );
  }

  const [result] = await db.query(
    `INSERT INTO ap_command_jobs (organization_id, device_id, command_type, target_value, status, notes, created_by)
     VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    [orgId, data.device_id, data.command_type, data.target_value ?? null, data.notes ?? null, userId || null],
  );
  await queueApCommand(result.insertId, orgId);
  return require('./wirelessService').getApCommandJob(result.insertId, orgId);
}

/**
 * Execute one queued command. Holds the job's advisory lock, so a job queued
 * twice runs once.
 * @returns {Promise<string|false>} the final status, or false when another
 *          process holds the job
 */
async function runApCommand(jobId, organizationId) {
  const { withAdvisoryLock } = require('../utils/advisoryLock');
  let finalStatus = 'skipped';
  const ran = await withAdvisoryLock(`ap-command:${jobId}`, async () => {
    const [[job]] = await db.query(
      `SELECT * FROM ap_command_jobs
        WHERE id = ? AND organization_id = ? AND status IN ('pending','queued','in_progress') AND deleted_at IS NULL`,
      [jobId, organizationId],
    );
    if (!job) return;

    if (job.status === 'in_progress') {
      await db.query(
        `UPDATE ap_command_jobs SET status = 'failed', completed_at = NOW(),
                error_message = 'Interrupted while running; check the device before sending it again'
          WHERE id = ? AND organization_id = ? AND status = 'in_progress'`,
        [jobId, organizationId],
      );
      finalStatus = 'failed';
      return;
    }

    // Claimed against the state just read, so a job cancelled meanwhile stays cancelled.
    const [claim] = await db.query(
      `UPDATE ap_command_jobs SET status = 'in_progress', started_at = NOW()
        WHERE id = ? AND organization_id = ? AND status IN ('pending','queued')`,
      [jobId, organizationId],
    );
    if (Number(claim.affectedRows) !== 1) return;

    let status = 'failed';
    let output = null;
    let error = null;
    try {
      const driverCommand = EXECUTABLE[job.command_type];
      const config = driverCommand && await driverConfigFor(job.device_id, organizationId, driverCommand);
      if (!config) throw new Error(`No driver can run '${job.command_type}' on this device`);
      const result = await require('./routerDriverService')
        .dispatchCommand(config.id, organizationId, driverCommand, {}, job.created_by || null);
      if (result && result.status === 'success') {
        status = 'completed';
        output = JSON.stringify({ execution_id: result.execution_id, response: result.response });
      } else {
        error = result?.error_message || 'The device did not accept the command';
      }
    } catch (err) {
      error = err.message;
    }
    await db.query(
      `UPDATE ap_command_jobs SET status = ?, completed_at = NOW(), result_output = ?, error_message = ?
        WHERE id = ? AND organization_id = ?`,
      [status, output, error ? String(error).slice(0, 2000) : null, jobId, organizationId],
    );
    finalStatus = status;
    logger.info({ jobId, organizationId, status }, 'AP command finished');
  });
  return ran ? finalStatus : false;
}

/** Queue every unfinished command again (called at start-up). */
async function resumeApCommands() {
  let count = 0;
  const fanOut = require('./organizationFanOut');
  await fanOut.forEachDatabaseScope('resume_ap_commands', async (scopeOrgId) => {
    const { sql, params } = fanOut.orgScopeFilter('organization_id', scopeOrgId);
    const [rows] = await db.query(
      `SELECT id, organization_id FROM ap_command_jobs
        WHERE status IN ('pending','queued','in_progress') AND deleted_at IS NULL AND organization_id IS NOT NULL${sql}`,
      params,
    );
    for (const row of rows) await queueApCommand(row.id, row.organization_id);
    count += rows.length;
  });
  if (count) logger.info({ count }, 'Resumed unfinished AP commands');
  return count;
}

module.exports = { EXECUTABLE, driverConfigFor, createApCommandJob, runApCommand, queueApCommand, resumeApCommands };
