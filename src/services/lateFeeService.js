// =============================================================================
// VigaBSS 5.0 — Late Fee Service
// =============================================================================
// Applies configured late fee rules to overdue invoices.
// Emits invoice.late_fee_applied event for notification hooks.
// =============================================================================

const db = require('../config/database');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');
const billingService = require('./billingService');

/**
 * List active late fee rules for an organization.
 * @param {number} organizationId
 * @returns {Promise<object[]>}
 */
async function getLateFeeRules(organizationId) {
  const [rows] = await db.query(
    'SELECT * FROM late_fee_rules WHERE organization_id = ? ORDER BY id',
    [organizationId],
  );
  return rows;
}

/**
 * Create a late fee rule.
 * @param {number} organizationId
 * @param {object} data
 * @returns {Promise<object>}
 */
async function createLateFeeRule(organizationId, data) {
  const { name, fee_type = 'flat', fee_amount = 0, grace_period_days = 0, max_applications = null, is_active = 1 } = data;
  const [result] = await db.query(
    `INSERT INTO late_fee_rules (organization_id, name, fee_type, fee_amount, grace_period_days, max_applications, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [organizationId, name, fee_type, fee_amount, grace_period_days, max_applications, is_active ? 1 : 0],
  );
  const [rows] = await db.query('SELECT * FROM late_fee_rules WHERE id = ?', [result.insertId]);
  return rows[0];
}

/**
 * Update a late fee rule.
 * @param {number} organizationId
 * @param {number} ruleId
 * @param {object} data
 * @returns {Promise<object|null>}
 */
async function updateLateFeeRule(organizationId, ruleId, data) {
  const fields = [];
  const vals = [];

  const allowed = ['name', 'fee_type', 'fee_amount', 'grace_period_days', 'max_applications', 'is_active'];
  for (const key of allowed) {
    if (key in data) {
      fields.push(`${key} = ?`);
      vals.push(data[key]);
    }
  }
  if (fields.length === 0) return getLateFeeRuleById(organizationId, ruleId);

  vals.push(ruleId, organizationId);
  await db.query(
    `UPDATE late_fee_rules SET ${fields.join(', ')} WHERE id = ? AND organization_id = ?`,
    vals,
  );
  return getLateFeeRuleById(organizationId, ruleId);
}

/**
 * Get a single rule by id.
 * @param {number} organizationId
 * @param {number} ruleId
 * @returns {Promise<object|null>}
 */
async function getLateFeeRuleById(organizationId, ruleId) {
  const [rows] = await db.query(
    'SELECT * FROM late_fee_rules WHERE id = ? AND organization_id = ?',
    [ruleId, organizationId],
  );
  return rows[0] || null;
}

/**
 * Delete a late fee rule.
 * @param {number} organizationId
 * @param {number} ruleId
 * @returns {Promise<boolean>}
 */
async function deleteLateFeeRule(organizationId, ruleId) {
  const [result] = await db.query(
    'DELETE FROM late_fee_rules WHERE id = ? AND organization_id = ?',
    [ruleId, organizationId],
  );
  return result.affectedRows > 0;
}

/**
 * Apply late fees to all eligible overdue invoices for an organization.
 * Each rule applies at most once per invoice per calendar month (UTC) and at
 * most max_applications times in total, so rerunning is safe.
 *
 * @param {number} organizationId
 * @returns {Promise<{ fees_applied: number, invoices_checked: number }>}
 */
async function applyLateFees(organizationId) {
  // Fetch active rules for this org
  const [rules] = await db.query(
    'SELECT * FROM late_fee_rules WHERE organization_id = ? AND is_active = 1',
    [organizationId],
  );
  if (rules.length === 0) return { fees_applied: 0, invoices_checked: 0 };

  // Find overdue invoices (status 'issued' or 'overdue') with a due_date in the past
  const [invoices] = await db.query(
    `SELECT i.id, i.invoice_number, i.total, i.subtotal, i.tax_amount, i.tax_rate,
            i.currency, i.due_date, i.client_id, i.contract_id,
            DATEDIFF(NOW(), i.due_date) AS days_overdue,
            cl.name AS client_name,
            cl.email AS client_email, cl.phone AS client_phone
     FROM invoices i
     LEFT JOIN clients cl ON cl.id = i.client_id
     WHERE i.organization_id = ?
       AND i.status IN ('issued', 'overdue')
       AND i.due_date < CURDATE()
       AND i.deleted_at IS NULL
       -- No late fees on an archived client's invoices (DAL-03).
       AND cl.deleted_at IS NULL
       -- Never mutate an invoice that already carries a live CFDI: adding a
       -- line item + changing totals would desync it from the stamped, filed
       -- document. Such invoices need a separate charge (nota de cargo), not
       -- an in-place edit.
       -- 'draft' belongs here too: a draft CFDI has ALREADY snapshotted its
       -- conceptos from the current line items and is waiting on a stamp retry,
       -- so adding a late-fee line silently makes the pending document disagree
       -- with the invoice it will be filed against. Every sibling guard
       -- (routes/invoices.js, billingService, invoiceCfdiService,
       -- creditNoteCfdiService) already includes it; this query was the outlier.
       AND NOT EXISTS (
         SELECT 1 FROM cfdi_documents cd
         WHERE cd.invoice_id = i.id
           AND cd.sat_status IN ('draft', 'vigente', 'cancel_pending')
       )`,
    [organizationId],
  );

  let feesApplied = 0;
  // A rule applies at most once per invoice per calendar month (UTC), and at
  // most max_applications times in total (NULL = no total cap). The scheduled
  // task runs daily, so without the per-month bound an "unlimited" rule added
  // a new fee every day. The UNIQUE (invoice, rule, period_key) key (migration
  // 473) makes the bound hold across concurrent runs too.
  const periodKey = new Date().toISOString().slice(0, 7);

  for (const invoice of invoices) {
    for (const rule of rules) {
      // Check grace period: invoice must be overdue beyond rule's grace period
      if (invoice.days_overdue <= rule.grace_period_days) continue;

      const [existing] = await db.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(period_key = ?), 0) AS this_period
           FROM invoice_late_fees WHERE invoice_id = ? AND late_fee_rule_id = ?`,
        [periodKey, invoice.id, rule.id],
      );
      if (Number(existing[0].this_period) > 0) continue;
      const alreadyApplied = Number(existing[0].cnt);
      if (rule.max_applications !== null && alreadyApplied >= rule.max_applications) continue;

      // Calculate fee amount. A percent fee is a percentage of the NET subtotal
      // (not the tax-inclusive total) — the fee is booked as a taxable line and
      // taxed once below, so basing it on the gross total would tax it twice
      // (effective surcharge p*(1+rate) instead of p). Earlier late fees are
      // taken out of the base so a monthly percent fee does not compound.
      let feeAmount;
      if (rule.fee_type === 'percent') {
        const [prior] = await db.query(
          'SELECT COALESCE(SUM(amount), 0) AS fees FROM invoice_late_fees WHERE invoice_id = ?',
          [invoice.id],
        );
        const base = parseFloat(invoice.subtotal) - parseFloat(prior[0].fees || 0);
        feeAmount = base * (parseFloat(rule.fee_amount) / 100);
      } else {
        feeAmount = parseFloat(rule.fee_amount);
      }
      feeAmount = Math.round(feeAmount * 100) / 100;
      if (feeAmount <= 0) continue;

      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        const exec = conn.execute.bind(conn);

        // Claim this (invoice, rule, month) first: a concurrent run hits the
        // unique key here and adds nothing.
        let claim;
        try {
          [claim] = await exec(
            `INSERT INTO invoice_late_fees
               (invoice_id, late_fee_rule_id, organization_id, amount, applied_by, invoice_item_id, period_key)
             VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
            [invoice.id, rule.id, organizationId, feeAmount, periodKey],
          );
        } catch (dupErr) {
          if (dupErr.code === 'ER_DUP_ENTRY' || dupErr.errno === 1062) {
            await conn.rollback();
            continue;
          }
          throw dupErr;
        }

        const [itemResult] = await exec(
          `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount)
           VALUES (?, ?, 1, ?, ?)`,
          [invoice.id, `Late fee: ${rule.name}`, feeAmount, feeAmount],
        );
        await exec(
          'UPDATE invoice_late_fees SET invoice_item_id = ? WHERE id = ?',
          [itemResult.insertId, claim.insertId],
        );

        // Book the fee as a taxable line via the canonical DELTA helper: it adds
        // only the fee (subtotal += fee) and the fee's OWN tax (tax_amount +=
        // round(fee*rate)), so total = subtotal + tax stays consistent WITHOUT
        // recomputing (and silently rewriting) the invoice's original tax_amount.
        const lineTax = Math.round(feeAmount * billingService.invoiceTaxFraction(invoice.tax_rate) * 100) / 100;
        await billingService.applyLineItemToTotals(exec, invoice.id, invoice.tax_rate, feeAmount);
        await conn.commit();

        // Keep the in-memory invoice in sync so a second rule in this loop
        // accumulates on the updated figures.
        invoice.subtotal = Math.round((parseFloat(invoice.subtotal) + feeAmount) * 100) / 100;
        invoice.tax_amount = Math.round((parseFloat(invoice.tax_amount) + lineTax) * 100) / 100;
        invoice.total = Math.round((parseFloat(invoice.total) + feeAmount + lineTax) * 100) / 100;

        feesApplied++;

        // Emit event for notification hooks
        eventBus.emit('invoice.late_fee_applied', {
          organizationId,
          invoice: {
            id: invoice.id,
            invoice_number: invoice.invoice_number,
            client_id: invoice.client_id,
          },
          client: {
            id: invoice.client_id,
            name: invoice.client_name,
            email: invoice.client_email,
            phone: invoice.client_phone,
          },
          rule: { id: rule.id, name: rule.name, fee_type: rule.fee_type },
          fee_amount: feeAmount,
          currency: invoice.currency,
        });
      } catch (err) {
        await conn.rollback().catch(() => {});
        logger.error({ err, invoiceId: invoice.id, ruleId: rule.id }, 'lateFeeService: error applying fee');
      } finally {
        conn.release();
      }
    }
  }

  return { fees_applied: feesApplied, invoices_checked: invoices.length };
}

module.exports = {
  getLateFeeRules,
  createLateFeeRule,
  updateLateFeeRule,
  getLateFeeRuleById,
  deleteLateFeeRule,
  applyLateFees,
};
