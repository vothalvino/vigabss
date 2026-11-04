// =============================================================================
// VigaBSS — CPE firmware campaigns over TR-069 Download (NET-26)
// =============================================================================
// A campaign was a row nobody acted on: status 'scheduled' for good, no CPE
// ever told to download anything. POST /firmware-campaigns/:id/launch now
// queues one CWMP 'download' task per targeted CPE of the organization. The
// ACS sends the Download RPC at each CPE's next Inform, and the campaign's
// counters follow those tasks:
//
//   - targets: target_device_ids when given, else every CPE matching the
//     campaign's manufacturer/model/profile, defaulting to the firmware
//     version's own manufacturer and model;
//   - completed_devices counts CPEs that accepted the Download (DownloadResponse),
//     failed_devices those that faulted or never answered (acsService reaps a
//     task after the session timeout); the campaign is 'done' when none is left;
//   - cancelling drops the tasks no CPE has picked up yet.
//
// A future scheduled_at is refused: nothing starts campaigns on a timer.
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'cpeFirmwareCampaignService' });
const { AppError, NotFoundError, ValidationError, ConflictError } = require('../utils/errors');

const MAX_CAMPAIGN_DEVICES = 5000;
const FILE_TYPE = '1 Firmware Upgrade Image';

function parseIds(value) {
  if (value === null || value === undefined) return null;
  const list = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(list)) throw new ValidationError('target_device_ids must be an array of CPE device ids');
  const ids = [...new Set(list.map(Number))];
  if (ids.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new ValidationError('target_device_ids must be positive CPE device ids');
  return ids;
}

/** Refuse what the executor cannot honour, before the row is stored. */
function assertRunnable(body) {
  if (body.scheduled_at) {
    const at = new Date(body.scheduled_at);
    if (Number.isNaN(at.getTime())) throw new ValidationError('scheduled_at is not a date');
    if (at.getTime() > Date.now() + 60 * 1000) {
      throw new AppError(
        'Scheduled firmware campaigns are not started automatically yet; leave scheduled_at empty and launch the campaign when it should run.',
        501,
        'CAMPAIGN_SCHEDULE_NOT_IMPLEMENTED',
      );
    }
  }
  if (body.target_device_ids !== undefined) parseIds(body.target_device_ids);
}

async function targetDevices(campaign, version, orgId) {
  const explicit = parseIds(campaign.target_device_ids);
  if (explicit && explicit.length) {
    const [rows] = await db.query(
      'SELECT id FROM cpe_devices WHERE id IN (?) AND organization_id = ? AND deleted_at IS NULL',
      [explicit, orgId],
    );
    if (rows.length !== explicit.length) throw new ValidationError('target_device_ids lists CPEs that are not this organization\'s');
    return rows.map(r => r.id);
  }
  const where = [];
  const params = [orgId];
  const manufacturer = campaign.target_manufacturer || version.manufacturer;
  const model = campaign.target_model || version.model_name;
  if (manufacturer) { where.push('manufacturer = ?'); params.push(manufacturer); }
  if (model) { where.push('model_name = ?'); params.push(model); }
  if (campaign.target_profile_id) { where.push('cpe_profile_id = ?'); params.push(campaign.target_profile_id); }
  const [rows] = await db.query(
    `SELECT id FROM cpe_devices WHERE organization_id = ? AND deleted_at IS NULL${where.map(w => ` AND ${w}`).join('')}
      ORDER BY id LIMIT ${MAX_CAMPAIGN_DEVICES + 1}`,
    params,
  );
  return rows.map(r => r.id);
}

/**
 * Start a campaign: one queued download task per target CPE.
 * @returns {Promise<object>} the campaign row
 */
async function startCampaign(campaignId, orgId, userId = null) {
  const [[campaign]] = await db.query(
    'SELECT * FROM cpe_firmware_campaigns WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [campaignId, orgId],
  );
  if (!campaign) throw new NotFoundError('Firmware campaign');
  if (campaign.status !== 'scheduled') throw new ConflictError(`A ${campaign.status} campaign cannot be launched`);
  assertRunnable(campaign);

  const [[version]] = await db.query(
    `SELECT id, manufacturer, model_name, version, firmware_url, file_size_bytes FROM cpe_firmware_versions
      WHERE id = ? AND (organization_id = ? OR organization_id IS NULL) AND deleted_at IS NULL`,
    [campaign.firmware_version_id, orgId],
  );
  if (!version) throw new ValidationError('The campaign\'s firmware version does not exist');

  const devices = await targetDevices(campaign, version, orgId);
  if (devices.length === 0) throw new ValidationError('No CPE of this organization matches the campaign\'s targets');
  if (devices.length > MAX_CAMPAIGN_DEVICES) {
    throw new ValidationError(`A campaign targets at most ${MAX_CAMPAIGN_DEVICES} CPEs; narrow it with target_device_ids, model or profile`);
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    // Claimed in the transaction, so two starts cannot both queue tasks.
    const [claim] = await conn.query(
      `UPDATE cpe_firmware_campaigns SET status = 'running', started_at = NOW(), total_devices = ?,
              completed_devices = 0, failed_devices = 0
        WHERE id = ? AND organization_id = ? AND status = 'scheduled'`,
      [devices.length, campaignId, orgId],
    );
    if (Number(claim.affectedRows) !== 1) throw new ConflictError('The campaign was launched or changed meanwhile');
    const parameters = JSON.stringify({
      url: version.firmware_url,
      fileType: FILE_TYPE,
      fileSize: Number(version.file_size_bytes) || 0,
      _campaignId: Number(campaignId),
    });
    for (let i = 0; i < devices.length; i += 500) {
      const chunk = devices.slice(i, i + 500);
      await conn.query(
        'INSERT INTO cpe_tasks (organization_id, cpe_device_id, task_type, parameters, status, created_by) VALUES ?',
        [chunk.map(id => [orgId, id, 'download', parameters, 'queued', userId])],
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  logger.info({ campaignId, orgId, devices: devices.length, version: version.version }, 'Firmware campaign started');
  const [[row]] = await db.query('SELECT * FROM cpe_firmware_campaigns WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [campaignId, orgId]);
  return row;
}

/** Recount a campaign from its tasks; 'done' once no task is left to settle. */
async function refreshCampaign(campaignId, orgId) {
  const [[counts]] = await db.query(
    `SELECT SUM(status = 'done') AS ok, SUM(status = 'failed') AS failed,
            SUM(status IN ('queued','in_progress')) AS open
       FROM cpe_tasks
      WHERE organization_id <=> ? AND task_type = 'download'
        AND JSON_EXTRACT(parameters, '$._campaignId') = ?`,
    [orgId, Number(campaignId)],
  );
  const open = Number(counts?.open || 0);
  await db.query(
    `UPDATE cpe_firmware_campaigns
        SET completed_devices = ?, failed_devices = ?,
            status = IF(status = 'running' AND ? = 0, 'done', status),
            completed_at = IF(status = 'done' AND completed_at IS NULL, NOW(), completed_at)
      WHERE id = ? AND organization_id <=> ? AND deleted_at IS NULL`,
    [Number(counts?.ok || 0), Number(counts?.failed || 0), open, campaignId, orgId],
  );
}

/**
 * Called when a CPE task settles. Only a campaign's download tasks matter;
 * a failure here never fails the CWMP session.
 */
async function afterTaskSettled(task) {
  if (!task || task.task_type !== 'download') return;
  let params = task.parameters;
  try { params = typeof params === 'string' ? JSON.parse(params) : params; } catch { return; }
  if (!params || !params._campaignId) return;
  await refreshCampaign(params._campaignId, task.organization_id ?? null)
    .catch(err => logger.warn({ err: err.message, taskId: task.id }, 'Could not refresh the firmware campaign'));
}

/** Cancel a campaign; CPEs that already took the Download keep it. */
async function cancelCampaign(campaignId, orgId) {
  const [result] = await db.query(
    `UPDATE cpe_firmware_campaigns SET status = 'cancelled', completed_at = NOW()
      WHERE id = ? AND organization_id = ? AND status IN ('scheduled','running') AND deleted_at IS NULL`,
    [campaignId, orgId],
  );
  if (!Number(result.affectedRows)) {
    const [[row]] = await db.query('SELECT status FROM cpe_firmware_campaigns WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [campaignId, orgId]);
    if (!row) throw new NotFoundError('Firmware campaign');
    throw new ConflictError(`A ${row.status} campaign cannot be cancelled`);
  }
  await db.query(
    `DELETE FROM cpe_tasks
      WHERE organization_id = ? AND task_type = 'download' AND status = 'queued'
        AND JSON_EXTRACT(parameters, '$._campaignId') = ?`,
    [orgId, Number(campaignId)],
  );
  const [[row]] = await db.query('SELECT * FROM cpe_firmware_campaigns WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [campaignId, orgId]);
  return row;
}

module.exports = { MAX_CAMPAIGN_DEVICES, assertRunnable, startCampaign, refreshCampaign, afterTaskSettled, cancelCampaign };
