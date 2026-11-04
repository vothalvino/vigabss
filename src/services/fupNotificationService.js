'use strict';

// =============================================================================
// VigaBSS 5.0 — FUP Usage Notification Service (§10.3)
// =============================================================================
// Checks subscriber data usage against their plan caps and sends de-duplicated
// notifications at the 80%, 90%, and 100% thresholds each billing month.
// =============================================================================

const db = require('../config/database');
const dataPackService = require('./dataPackService');
const { buildUnverifiableSessionOverlap } = require('../utils/accountingUsageCompleteness');

/**
 * Check all active contracts in an org for 80/90/100% threshold crossings
 * and record a notification row (dedup via UNIQUE KEY).
 *
 * @param {number} organizationId
 * @returns {Promise<{checked: number, notified: number}>}
 */
/**
 * Tell the subscriber they crossed a usage threshold: email, else SMS, else
 * portal push. Transactional class, so the client's communication
 * preferences apply in the transports.
 *
 * @returns {Promise<'email'|'sms'|'push'|null>} the channel that delivered it
 */
async function deliverThresholdNotice(contract, threshold, usedGb, allowanceGb) {
  const subject = threshold >= 100
    ? 'Alcanzaste el 100% de tus datos del mes'
    : `Llevas el ${threshold}% de tus datos del mes`;
  const text = `${subject}: ${usedGb.toFixed(1)} GB de ${allowanceGb.toFixed(1)} GB.`;
  // Through the outbox, delivered now (ASY-33). One attempt per channel
  // (maxAttempts 1): a channel that fails falls back to the next instead of
  // also being retried later, which would deliver the notice twice.
  const outbox = require('./messageOutbox');
  const base = {
    organizationId: contract.organization_id, clientId: contract.client_id, messageClass: 'transactional',
    maxAttempts: 1, sourceType: 'fup_threshold', sourceId: contract.id,
  };
  const delivered = r => r && r.status === 'sent';

  if (contract.client_email) {
    const result = await outbox.sendNow({
      ...base, channel: 'email', recipient: contract.client_email, subject, bodyText: text, bodyHtml: `<p>${text}</p>`,
    }).catch(() => null);
    if (delivered(result)) return 'email';
  }
  if (contract.client_phone) {
    const result = await outbox.sendNow({ ...base, channel: 'sms', recipient: contract.client_phone, bodyText: text }).catch(() => null);
    if (delivered(result)) return 'sms';
  }
  const pushed = await outbox.sendNow({
    ...base, channel: 'push', payload: { event_type: 'billing', title: subject, body: text, url: '/portal/dashboard' },
  }).catch(() => null);
  if (delivered(pushed)) return 'push';
  return null;
}

/**
 * A contract's data use this billing month, from complete accounting days
 * only, or null when the counters cannot be trusted yet (an incomplete day,
 * a session spanning the boundary, or no data at all): nothing may notify or
 * throttle from them. Packs bought this month and available rollover extend
 * the allowance (TNA-21) and are returned as extraGb.
 *
 * @param {{ id: number, organization_id: number }} contract
 * @param {string} billingMonth  YYYY-MM-01
 * @param {string} endStr        YYYY-MM-DD, the month's last day
 * @returns {Promise<{ usedGb: number, extraGb: number }|null>}
 */
async function monthUsage(contract, billingMonth, endStr) {
  const [[usage]] = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN is_complete = 1
                  THEN bytes_in_delta + bytes_out_delta ELSE 0 END) / 1073741824.0, 0) AS used_gb,
            COALESCE(SUM(is_complete = 0), 0) AS incomplete_rows
            , COUNT(*) AS observed_rows,
            (SELECT COUNT(*) FROM connection_logs unverifiable
              WHERE unverifiable.organization_id = ? AND unverifiable.contract_id = ?
                AND ${buildUnverifiableSessionOverlap('unverifiable', '?', 'DATE_ADD(?, INTERVAL 1 DAY)')}) AS unverifiable_session_rows
       FROM radius_accounting_usage_daily
      WHERE organization_id = ? AND contract_id = ?
        AND usage_date >= ? AND usage_date <= ?`,
    [contract.organization_id, contract.id, billingMonth, endStr,
      contract.organization_id, contract.id, billingMonth, endStr],
  );

  // Never throttle/notify from an uncertain counter baseline or an interval
  // that crossed a UTC billing boundary without exact allocation.
  if (!usage || Number(usage.observed_rows || 0) === 0 || Number(usage.incomplete_rows || 0) > 0
      || Number(usage.unverifiable_session_rows || 0) > 0) return null;

  const extra = await dataPackService.extraAllowanceGb(contract.id, contract.organization_id, billingMonth, endStr);
  return { usedGb: parseFloat(usage.used_gb) || 0, extraGb: Number(extra.total_gb) || 0 };
}

async function checkAndNotifyThresholds(organizationId) {
  const now = new Date();
  const billingMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const endStr = endOfMonth.toISOString().slice(0, 10);

  const [contracts] = await db.query(
    `SELECT c.id, c.organization_id, c.client_id,
            p.data_cap_gb, p.fup_threshold_gb,
            cl.email AS client_email, cl.phone AS client_phone
     FROM contracts c
     JOIN plans p ON c.plan_id = p.id
     LEFT JOIN clients cl ON cl.id = c.client_id AND cl.deleted_at IS NULL
     WHERE c.status = 'active'
       AND (p.data_cap_gb IS NOT NULL OR p.fup_threshold_gb IS NOT NULL)
       AND c.organization_id = ?
       AND c.deleted_at IS NULL`,
    [organizationId],
  );

  let checked = 0;
  let notified = 0;

  for (const contract of contracts) {
    checked++;
    const capGb = parseFloat(contract.data_cap_gb) || parseFloat(contract.fup_threshold_gb) || 0;
    if (capGb <= 0) continue;

    const usage = await monthUsage(contract, billingMonth, endStr);
    if (!usage) continue;
    const usedGb = usage.usedGb;
    const usagePct = (usedGb / (capGb + usage.extraGb)) * 100;
    const extra = { total_gb: usage.extraGb };

    for (const threshold of [80, 90, 100]) {
      if (usagePct < threshold) continue;

      // Check dedup: already notified for this threshold this month?
      const [[existing]] = await db.query(
        `SELECT id FROM fup_usage_notifications
         WHERE contract_id = ? AND billing_month = ? AND threshold_pct = ?`,
        [contract.id, billingMonth, threshold],
      );
      if (existing) continue;

      // Deliver first; the dedup row records the channel that actually
      // carried the notice. Nothing delivered = no row, so the next check
      // retries instead of the month being marked as notified (SUP-07).
      const channel = await deliverThresholdNotice(contract, threshold, usedGb, capGb + extra.total_gb);
      if (!channel) continue;

      // Insert dedup record (ignore race duplicates via ER_DUP_ENTRY)
      try {
        await db.query(
          `INSERT INTO fup_usage_notifications
             (organization_id, contract_id, billing_month, threshold_pct, channel)
           VALUES (?, ?, ?, ?, ?)`,
          [contract.organization_id, contract.id, billingMonth, threshold, channel],
        );
        notified++;
        // Emit event for email/push/webhook hooks (best-effort)
        try {
          const eventBus = require('./eventBus');
          eventBus.emit('fup.threshold_reached', {
            organizationId: contract.organization_id,
            contractId: contract.id,
            clientId: contract.client_id,
            pct: threshold,
            used_gb: usedGb,
            cap_gb: capGb,
          });
        } catch (_e) {
          // eventBus is optional — swallow if not available
        }
      } catch (dupErr) {
        if (dupErr.code !== 'ER_DUP_ENTRY') throw dupErr;
      }
    }
  }

  return { checked, notified };
}

/**
 * List recent FUP usage notifications for an org, optionally filtered by
 * contract or billing month.
 *
 * @param {number} organizationId
 * @param {{contractId?: number, month?: string}} [filters]
 * @returns {Promise<Array>}
 */
async function listNotifications(organizationId, { contractId, month } = {}) {
  let where = 'fun.organization_id = ?';
  const params = [organizationId];
  if (contractId) {
    where += ' AND fun.contract_id = ?';
    params.push(contractId);
  }
  if (month) {
    where += ' AND fun.billing_month = ?';
    params.push(month);
  }
  const [rows] = await db.query(
    `SELECT fun.*
     FROM fup_usage_notifications fun
     WHERE ${where}
     ORDER BY fun.notified_at DESC
     LIMIT 200`,
    params,
  );
  return rows;
}

module.exports = { checkAndNotifyThresholds, listNotifications, monthUsage };
