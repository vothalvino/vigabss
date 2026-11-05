// =============================================================================
// VigaBSS 5.0 — Bill the rest of the period when a plan changes
// =============================================================================
// A period is invoiced up front at the plan price of that moment. Only an
// approved portal request billed the difference when the plan changed partway
// through (BIL-23); a staff or batch change billed nothing, so an upgrade got
// the faster plan free until the next period and a downgrade paid the old
// price for days on the slower plan. prorate() prices the remaining days of
// the contract's latest invoiced period at both prices and bills the net: a
// one-off invoice for an upgrade, an issued credit note for a downgrade, in
// the caller's transaction. A contract with a price_override pays the same
// whatever its plan, so it has nothing to prorate.
// =============================================================================

const billingService = require('./billingService');
const creditNoteLedgerService = require('./creditNoteLedgerService');
const Organization = require('../models/Organization');
const { businessToday } = require('../utils/businessDate');
const money = require('../utils/money');

/**
 * The proration of moving `contract` to `newPlanId` today, or null when there
 * is nothing to bill (no invoiced period, a price override, the period over).
 *
 * @param {Function} exec  query function of the caller's connection
 * @param {object} contract  the contracts row before the change
 * @param {number} newPlanId
 * @param {number} organizationId
 * @returns {Promise<null|{ net: number, credit: number, charge: number, daysRemaining: number, totalDays: number, oldPlanName: string, newPlanName: string }>}
 */
async function prorationFor(exec, contract, newPlanId, organizationId) {
  if (contract.price_override !== null && contract.price_override !== undefined && contract.price_override !== '') return null;
  const [plans] = await exec(
    `/* includes deleted rows: the contract's current plan may since have been archived */
     SELECT id, name, price FROM plans WHERE id IN (?, ?) AND (organization_id = ? OR organization_id IS NULL)`,
    [contract.plan_id, newPlanId, organizationId],
  );
  const oldPlan = plans.find(p => Number(p.id) === Number(contract.plan_id));
  const newPlan = plans.find(p => Number(p.id) === Number(newPlanId));
  if (!oldPlan || !newPlan) return null;
  const [periods] = await exec(
    `SELECT bp.period_start, bp.period_end FROM billing_periods bp
       JOIN contracts c ON c.id = bp.contract_id AND c.organization_id = ? AND c.deleted_at IS NULL
      WHERE bp.contract_id = ? AND bp.status = 'invoiced'
      ORDER BY bp.period_start DESC LIMIT 1`,
    [organizationId, contract.id],
  );
  if (!periods[0]) return null;
  const proration = billingService.calculateProration({
    oldPrice: oldPlan.price,
    newPrice: newPlan.price,
    changeDate: `${businessToday()}T00:00:00Z`,
    periodStart: periods[0].period_start,
    periodEnd: periods[0].period_end,
  });
  if (!proration.net) return null;
  return { ...proration, oldPlanName: oldPlan.name, newPlanName: newPlan.name };
}

/** An issued credit note for a downgrade's unused days, posted to the ledger. */
async function issueProrationCreditNote(exec, { organizationId, clientId, contractId, number, amount, description, createdBy }) {
  const tax = await billingService.resolveTaxContext(exec, { orgId: organizationId, clientId });
  const subtotal = money.round(amount);
  const taxAmount = money.mul(subtotal, tax.rate);
  const total = money.add(subtotal, taxAmount);
  const currency = await Organization.getCurrency(organizationId);

  const [result] = await exec(
    `INSERT INTO credit_notes
       (organization_id, client_id, contract_id, credit_note_number, issue_date, reason,
        subtotal, tax_rate, tax_amount, total, currency, tax_rate_id, notes, status, created_by)
     VALUES (?, ?, ?, ?, ?, 'other', ?, ?, ?, ?, ?, ?, ?, 'issued', ?)`,
    [organizationId, clientId, contractId || null, number, businessToday(), subtotal, tax.rate, taxAmount,
      total, currency, tax.taxRateId || null, description, createdBy || null],
  );
  await creditNoteLedgerService.syncCreditNoteLedger(exec, {
    id: result.insertId, client_id: clientId, credit_note_number: number,
    total, currency, status: 'issued',
  }, organizationId);
  return result.insertId;
}

/**
 * Bill a staff or batch plan change's proration inside `conn`'s transaction.
 * Returns what was billed, or null when there was nothing to bill.
 *
 * @param {object} conn  a connection in a transaction
 * @param {object} params
 * @param {object} params.contract  the contracts row before the change
 * @param {number} params.newPlanId
 * @param {number} params.organizationId
 * @param {number|null} [params.actorId]
 */
async function prorate(conn, { contract, newPlanId, organizationId, actorId = null }) {
  const exec = conn.execute.bind(conn);
  const proration = await prorationFor(exec, contract, newPlanId, organizationId);
  if (!proration) return null;
  const description = `Plan change proration: ${proration.oldPlanName} -> ${proration.newPlanName}`
    + ` (${proration.daysRemaining} of ${proration.totalDays} days)`;
  if (proration.net > 0) {
    const invoice = await billingService.createOneOffInvoice({
      orgId: organizationId, clientId: contract.client_id, contractId: contract.id,
      description, amount: proration.net, conn, performedBy: actorId,
    });
    return { net: proration.net, invoice };
  }
  const creditNoteId = await issueProrationCreditNote(exec, {
    organizationId,
    clientId: contract.client_id,
    contractId: contract.id,
    number: `PCN-C${contract.id}-${Date.now()}`,
    amount: -proration.net,
    description,
    createdBy: actorId,
  });
  return { net: proration.net, creditNoteId };
}

module.exports = { prorate, prorationFor, issueProrationCreditNote };
