// =============================================================================
// VigaBSS 5.0 — FUP (Fair Use Policy) Throttle Service
// =============================================================================
// Throttles a contract to its plan's FUP speeds once its data use this billing
// month passes the plan's FUP threshold, and restores the plan rate when the
// month ends or a data pack lifts it back under (ASY-36).
//
// The throttle is state, not a message: contracts.fup_throttled_month names
// the month a contract is throttled for (migration 519). RADIUS serves the FUP
// rate while it names the current month (radiusAttributeService.
// effectiveThrottle), so a reconnect stays throttled; the CoA only changes the
// live session. Setting and clearing the column are conditional UPDATEs, so a
// */15 check throttles and logs each contract once per month, never per tick.
// A soft suspension's throttle (NPR-01) wins while it lasts; FUP leaves it be.
// =============================================================================

const db = require('../config/database');
const radiusService = require('./radiusService');
const logger = require('../utils/logger').child({ service: 'fup' });
const { businessToday, startOfMonth, endOfMonth } = require('../utils/businessDate');
const {
  generateAttributes, generateThrottleAttributes, toNamedAttributes, fupThrottleActiveSql,
} = require('./radiusAttributeService');

/** The plan's FUP threshold in GB, or 0 when the plan has no FUP. */
function thresholdGb(plan) {
  const cap = parseFloat(plan.data_cap_gb) || 0;
  const explicit = parseFloat(plan.fup_threshold_gb) || 0;
  if (explicit > 0) return explicit;
  const pct = Number(plan.fup_threshold_percent) || 0;
  if (cap > 0 && pct > 0) return (cap * pct) / 100;
  return cap;
}

async function sendCoa(contractId, attributes) {
  try {
    const result = await radiusService.changeOfAuth(contractId, 'update', attributes);
    // sent:true means the NAS answered with a CoA-ACK.
    return { sent: !!(result && result.sent), response: JSON.stringify(result).slice(0, 200) };
  } catch (err) {
    return { sent: false, response: err.message ? err.message.slice(0, 200) : 'CoA failed' };
  }
}

/** FreeRADIUS serves the new rate on re-authentication (the embedded server reads the column). */
async function syncRadius(row, contractId) {
  await radiusService.syncFreeradiusTables(row.organization_id, { contractId: Number(contractId) }).catch(err => logger.warn(
    { err: err.message, contractId },
    'FUP state saved; FreeRADIUS rows follow at the next sync',
  ));
}

async function loadContract(contractId, organizationId) {
  const [rows] = await db.query(
    `SELECT c.id AS contract_id, c.organization_id, c.status, c.fup_throttled_month,
            c.soft_suspend_download_kbps, c.soft_suspend_upload_kbps,
            p.fup_download_speed_mbps, p.fup_upload_speed_mbps, p.radius_vendor,
            p.download_speed_mbps, p.upload_speed_mbps, p.burst_download_mbps, p.burst_upload_mbps,
            p.burst_threshold_mbps, p.burst_time_seconds, p.priority
       FROM contracts c
       JOIN plans p ON p.id = c.plan_id
      WHERE c.id = ? AND c.organization_id = ? AND c.deleted_at IS NULL`,
    [contractId, organizationId],
  );
  return rows[0] || null;
}

/**
 * Throttle a contract for a billing month. Does nothing (applied: false,
 * already: true) when it is already throttled for that month.
 *
 * @param {number} contractId
 * @param {number} organizationId  the contract's organization
 * @param {string} [month]  YYYY-MM-01, default the current business month
 */
async function applyFupThrottle(contractId, organizationId, month = startOfMonth(businessToday())) {
  const row = await loadContract(contractId, organizationId);
  if (!row) return { applied: false, message: 'Contract not found' };
  const dl = Number(row.fup_download_speed_mbps);
  const ul = Number(row.fup_upload_speed_mbps);
  if (!(dl > 0 && ul > 0)) return { applied: false, message: 'The plan has no FUP speeds' };

  const [claim] = await db.query(
    `UPDATE contracts SET fup_throttled_month = ?
      WHERE id = ? AND organization_id = ? AND (fup_throttled_month IS NULL OR fup_throttled_month < ?)`,
    [month, contractId, organizationId, month],
  );
  if (Number(claim.affectedRows) !== 1) return { applied: false, already: true };
  logger.info({ contractId, month }, 'Applying FUP throttle');
  await syncRadius(row, contractId);

  // A soft-suspended session keeps its (lower) throttle; RADIUS serves the
  // FUP rate once the suspension is lifted.
  const softSuspended = Number(row.soft_suspend_download_kbps) > 0 && Number(row.soft_suspend_upload_kbps) > 0;
  const coa = softSuspended
    ? { sent: false, response: 'Soft-suspended: the suspension throttle stays in force' }
    : await sendCoa(contractId, toNamedAttributes(generateThrottleAttributes(row.radius_vendor, dl * 1000, ul * 1000)));

  const [result] = await db.query(
    `INSERT INTO plan_throttle_logs
     (organization_id, contract_id, action, reason, throttle_download_mbps, throttle_upload_mbps, coa_sent, coa_response)
     VALUES (?, ?, 'throttle', 'fup', ?, ?, ?, ?)`,
    [row.organization_id, contractId, dl, ul, coa.sent ? 1 : 0, coa.response],
  );

  return {
    applied: true,
    log_id: result.insertId,
    coa_sent: coa.sent,
    throttle_download_mbps: dl,
    throttle_upload_mbps: ul,
  };
}

/**
 * Lift a contract's FUP throttle. Does nothing (restored: false) when it is
 * not throttled.
 *
 * @param {number} contractId
 * @param {number} organizationId  the contract's organization
 */
async function restoreFupSpeeds(contractId, organizationId) {
  const row = await loadContract(contractId, organizationId);
  if (!row) return { restored: false, message: 'Contract not found' };

  const [claim] = await db.query(
    'UPDATE contracts SET fup_throttled_month = NULL WHERE id = ? AND organization_id = ? AND fup_throttled_month IS NOT NULL',
    [contractId, organizationId],
  );
  if (Number(claim.affectedRows) !== 1) return { restored: false, message: 'Not FUP-throttled' };
  logger.info({ contractId }, 'Restoring FUP speeds');
  await syncRadius(row, contractId);

  const softSuspended = Number(row.soft_suspend_download_kbps) > 0 && Number(row.soft_suspend_upload_kbps) > 0;
  const coa = softSuspended || row.status !== 'active'
    ? { sent: false, response: 'Not restored live: the contract is suspended or soft-suspended' }
    : await sendCoa(contractId, toNamedAttributes(generateAttributes(row)));

  const [result] = await db.query(
    `INSERT INTO plan_throttle_logs
     (organization_id, contract_id, action, reason, coa_sent, coa_response)
     VALUES (?, ?, 'restore', 'fup', ?, ?)`,
    [row.organization_id, contractId, coa.sent ? 1 : 0, coa.response],
  );

  return { restored: true, log_id: result.insertId, coa_sent: coa.sent };
}

/**
 * The check_fup_thresholds run for one organization: restore last month's
 * throttles, then throttle each active contract over its FUP threshold this
 * month and restore any that a data pack brought back under it. Contracts
 * whose usage counters are not trustworthy yet are left as they are.
 *
 * @param {number} organizationId
 * @returns {Promise<{ checked: number, throttled: number, restored: number, uncertain: number }>}
 */
async function checkFupThresholds(organizationId) {
  const today = businessToday();
  const month = startOfMonth(today);
  const monthEnd = endOfMonth(today);
  const { monthUsage } = require('./fupNotificationService');
  const summary = { checked: 0, throttled: 0, restored: 0, uncertain: 0 };

  const [expired] = await db.query(
    `SELECT id FROM contracts
      WHERE organization_id = ? AND fup_throttled_month IS NOT NULL AND fup_throttled_month < ?`,
    [organizationId, month],
  );
  for (const { id } of expired) {
    if ((await restoreFupSpeeds(id, organizationId)).restored) summary.restored++;
  }

  const [contracts] = await db.query(
    `SELECT c.id, c.organization_id, ${fupThrottleActiveSql('c')} AS fup_throttle_active,
            p.data_cap_gb, p.fup_threshold_gb, p.fup_threshold_percent
       FROM contracts c
       JOIN plans p ON p.id = c.plan_id
      WHERE c.organization_id = ? AND c.status = 'active' AND c.deleted_at IS NULL
        AND p.fup_download_speed_mbps > 0 AND p.fup_upload_speed_mbps > 0
        AND (p.data_cap_gb IS NOT NULL OR p.fup_threshold_gb IS NOT NULL)`,
    [organizationId],
  );

  for (const contract of contracts) {
    const limitGb = thresholdGb(contract);
    if (limitGb <= 0) continue;
    summary.checked++;
    const usage = await monthUsage(contract, month, monthEnd);
    if (!usage) { summary.uncertain++; continue; }
    const over = usage.usedGb >= limitGb + usage.extraGb;
    const throttled = Number(contract.fup_throttle_active) === 1;
    if (over && !throttled) {
      if ((await applyFupThrottle(contract.id, organizationId, month)).applied) summary.throttled++;
    } else if (!over && throttled) {
      if ((await restoreFupSpeeds(contract.id, organizationId)).restored) summary.restored++;
    }
  }
  return summary;
}

module.exports = { applyFupThrottle, restoreFupSpeeds, checkFupThresholds, thresholdGb };
