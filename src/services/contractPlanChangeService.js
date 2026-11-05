// =============================================================================
// VigaBSS 5.0 — Put a contract's new plan on the network
// =============================================================================
// Changing contracts.plan_id changed nothing the subscriber felt: PUT
// /contracts/:id, an approved portal plan change and a batch change_plan all
// wrote the column and stopped (ASY-15). External FreeRADIUS kept the old
// plan group until a full sync, and the live session kept the old rate until
// the subscriber reconnected. Call pushPlanChange after the new plan_id is
// committed: it rewrites the contract's FreeRADIUS rows and sends the session
// a CoA at the rate now in force: the new plan's (with any speed window), or
// the soft-suspension / FUP throttle when one applies, which still wins.
// A RADIUS failure is reported, not thrown: the plan change itself stands.
// =============================================================================

const db = require('../config/database');
const radiusService = require('./radiusService');
const { planRateAttributes } = require('./suspensionService');
const logger = require('../utils/logger').child({ service: 'contractPlanChange' });
const {
  effectiveThrottle, generateThrottleAttributes, fupThrottleActiveSql, toNamedAttributes,
} = require('./radiusAttributeService');

/**
 * @param {number} contractId
 * @param {number} organizationId
 * @returns {Promise<{ pushed: boolean, synced?: boolean, coa_sent?: boolean, reason?: string }>}
 */
async function pushPlanChange(contractId, organizationId) {
  const [rows] = await db.query(
    `/* includes deleted rows: an archived plan still sets the rate of the contracts on it */
     SELECT c.id, c.status, c.plan_id, c.soft_suspend_download_kbps, c.soft_suspend_upload_kbps,
            ${fupThrottleActiveSql('c')} AS fup_throttle_active,
            p.radius_vendor, p.fup_download_speed_mbps, p.fup_upload_speed_mbps
       FROM contracts c
       JOIN plans p ON p.id = c.plan_id
      WHERE c.id = ? AND c.organization_id = ? AND c.deleted_at IS NULL`,
    [contractId, organizationId],
  );
  const contract = rows[0];
  if (!contract) return { pushed: false, reason: 'not_found' };
  // A suspended or pending contract has no service to change; its RADIUS rows
  // follow its plan when it is activated or reconnected.
  if (contract.status !== 'active') return { pushed: false, reason: 'not_active' };

  let synced = true;
  try {
    await radiusService.syncFreeradiusTables(organizationId, { contractId: Number(contractId) });
  } catch (err) {
    synced = false;
    logger.warn({ err: err.message, contractId }, 'Plan changed; FreeRADIUS rows follow at the next sync');
  }

  const throttle = effectiveThrottle(contract);
  const attributes = throttle
    ? toNamedAttributes(generateThrottleAttributes(contract.radius_vendor, throttle.downloadKbps, throttle.uploadKbps))
    : await planRateAttributes({ execute: (sql, p) => db.query(sql, p) }, contract.plan_id);
  let coaSent = false;
  try {
    const result = await radiusService.changeOfAuth(contractId, 'update', attributes);
    coaSent = Boolean(result && result.sent);
  } catch (err) {
    logger.warn({ err: err.message, contractId }, 'Plan changed; the live session keeps its rate until it reconnects');
  }
  return { pushed: true, synced, coa_sent: coaSent };
}

module.exports = { pushPlanChange };
