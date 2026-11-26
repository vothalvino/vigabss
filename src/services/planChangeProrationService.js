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
//
// Months billed ahead (services/billAheadService.js) are invoiced at the price
// of the day the money arrived, so a plan change reaches them too:
//
//   upgrade    each month already invoiced owes the difference; it is added
//              to the one-off invoice.
//   downgrade  each such month keeps its invoice. The difference is covered
//              by a credit note on that invoice, and the same amount of the
//              customer's payment is taken off it, which makes it credit
//              again. The caller then runs billAheadService, and that credit
//              pays for further months: the prepaid time is extended.
//
// The period that contains today is the one prorated by days; the months
// after it are whole months.
// =============================================================================

const billingService = require('./billingService');
const creditNoteLedgerService = require('./creditNoteLedgerService');
const creditNoteApplicationService = require('./creditNoteApplicationService');
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
  const { current, ahead } = await invoicedPeriods(exec, contract.id, organizationId);
  const zero = { credit: 0, charge: 0, net: 0, daysRemaining: 0, totalDays: 0 };
  const proration = current ? billingService.calculateProration({
    oldPrice: oldPlan.price,
    newPrice: newPlan.price,
    changeDate: `${businessToday()}T00:00:00Z`,
    periodStart: current.period_start,
    periodEnd: current.period_end,
  }) : zero;
  // Whole months already invoiced after the current one.
  const monthDifference = money.round(Number(newPlan.price) - Number(oldPlan.price));
  const aheadNet = money.round(monthDifference * ahead.length);
  const net = money.round(proration.net + aheadNet);
  if (!net) return null;
  return {
    ...proration,
    net,
    currentNet: proration.net,
    aheadNet,
    aheadMonths: ahead.length,
    aheadInvoiceIds: ahead.map((p) => Number(p.invoice_id)).filter(Boolean),
    monthDifference,
    oldPlanName: oldPlan.name,
    newPlanName: newPlan.name,
  };
}

const dayOf = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

/**
 * The contract's invoiced periods that are not over: the one that contains
 * today, and the months after it (billed ahead).
 */
async function invoicedPeriods(exec, contractId, organizationId) {
  const today = businessToday();
  const [rows] = await exec(
    `SELECT bp.period_start, bp.period_end, bp.invoice_id FROM billing_periods bp
       JOIN contracts c ON c.id = bp.contract_id AND c.organization_id = ? AND c.deleted_at IS NULL
      WHERE bp.contract_id = ? AND bp.status = 'invoiced' AND bp.period_end >= ?
      ORDER BY bp.period_start ASC`,
    [organizationId, contractId, today],
  );
  const periods = rows || [];
  return {
    current: periods.find((p) => dayOf(p.period_start) <= today && dayOf(p.period_end) >= today) || null,
    ahead: periods.filter((p) => dayOf(p.period_start) > today),
  };
}

/**
 * A downgrade reaches a month billed ahead: its invoice stays, a credit note
 * on it covers the difference, and that much of the customer's payment comes
 * off the invoice and is credit again.
 *
 * A payment already reported to SAT with a payment complement for this
 * invoice is left where it is; the part of the credit note it would have
 * made room for then stays as credit on the account.
 *
 * @returns {Promise<null|{ creditNoteId: number, freed: number }>}
 */
async function creditAheadInvoice(exec, {
  organizationId, clientId, contractId, invoiceId, difference, description, createdBy, number,
}) {
  const [invoices] = await exec(
    `SELECT id, client_id, subtotal, tax_rate, tax_rate_id, total, currency, status FROM invoices
      WHERE id = ? AND organization_id <=> ? AND client_id = ? AND deleted_at IS NULL
        AND status IN ('issued', 'sent', 'overdue', 'paid')
      FOR UPDATE`,
    [invoiceId, organizationId, clientId],
  );
  const invoice = invoices[0];
  if (!invoice) return null;
  const subtotal = money.round(Math.min(Number(difference), Number(invoice.subtotal)));
  if (!(subtotal > 0)) return null;
  const taxAmount = money.mul(subtotal, Number(invoice.tax_rate));
  const total = money.add(subtotal, taxAmount);

  // Make room on the invoice for the credit note: newest allocation first.
  const [allocations] = await exec(
    `SELECT id, payment_id, amount FROM payment_allocations
      WHERE invoice_id = ? AND deleted_at IS NULL
      ORDER BY id DESC
      FOR UPDATE`,
    [invoiceId],
  );
  const allocated = money.round((allocations || []).reduce((t, a) => t + Number(a.amount), 0));
  const owed = Math.max(0, money.round(Number(invoice.total) - allocated));
  let toFree = Math.max(0, money.round(total - owed));
  let freed = 0;
  const repService = require('./repService');
  for (const allocation of allocations || []) {
    if (toFree < 0.005) break;
    try {
      await repService.assertNoBindingRep(exec, { paymentId: allocation.payment_id, orgId: organizationId, invoiceId });
    } catch (err) {
      if (err && err.code === 'PAYMENT_HAS_REP') continue;
      throw err;
    }
    const cut = money.round(Math.min(toFree, Number(allocation.amount)));
    const left = money.round(Number(allocation.amount) - cut);
    if (left < 0.005) {
      await exec('UPDATE payment_allocations SET deleted_at = NOW() WHERE id = ?', [allocation.id]);
    } else {
      await exec('UPDATE payment_allocations SET amount = ? WHERE id = ?', [left, allocation.id]);
    }
    toFree = money.round(toFree - cut);
    freed = money.round(freed + cut);
  }

  const [result] = await exec(
    `INSERT INTO credit_notes
       (organization_id, client_id, contract_id, invoice_id, credit_note_number, issue_date, reason,
        subtotal, tax_rate, tax_amount, total, currency, tax_rate_id, notes, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'other', ?, ?, ?, ?, ?, ?, ?, 'issued', ?)`,
    [organizationId, clientId, contractId || null, invoiceId, number, businessToday(), subtotal, invoice.tax_rate, taxAmount,
      total, invoice.currency, invoice.tax_rate_id || null, description, createdBy || null],
  );
  const note = {
    id: result.insertId, client_id: clientId, invoice_id: invoiceId, credit_note_number: number,
    total, currency: invoice.currency, status: 'issued', deleted_at: null,
  };
  await creditNoteLedgerService.syncCreditNoteLedger(exec, note, organizationId);
  await creditNoteApplicationService.syncApplication(exec, note, organizationId);
  return { creditNoteId: result.insertId, freed };
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
  const days = proration.totalDays ? ` (${proration.daysRemaining} of ${proration.totalDays} days)` : '';
  const months = proration.aheadMonths ? `, and ${proration.aheadMonths} month(s) billed ahead` : '';
  const description = `Plan change proration: ${proration.oldPlanName} -> ${proration.newPlanName}${days}${months}`;
  if (proration.net > 0) {
    // An upgrade: the rest of this period and every month already invoiced
    // owe the difference, on one invoice.
    const invoice = await billingService.createOneOffInvoice({
      orgId: organizationId, clientId: contract.client_id, contractId: contract.id,
      description, amount: proration.net, conn, performedBy: actorId,
    });
    return { net: proration.net, invoice, aheadMonths: proration.aheadMonths, freed: 0 };
  }
  // A downgrade. The unused days of this period become credit on the account.
  let creditNoteId = null;
  if (proration.currentNet < 0) {
    creditNoteId = await issueProrationCreditNote(exec, {
      organizationId,
      clientId: contract.client_id,
      contractId: contract.id,
      number: `PCN-C${contract.id}-${Date.now()}`,
      amount: -proration.currentNet,
      description,
      createdBy: actorId,
    });
  }
  // Each month billed ahead keeps its invoice; the difference comes back as
  // credit, which the caller turns into further months (billAheadService).
  const ahead = await creditAheadMonths(exec, {
    organizationId, contract, proration, actorId,
  });
  return { net: proration.net, creditNoteId, aheadMonths: proration.aheadMonths, ...ahead };
}

/** The downgrade's credit notes on the months billed ahead. */
async function creditAheadMonths(exec, { organizationId, contract, proration, actorId = null }) {
  const out = { aheadCreditNoteIds: [], freed: 0 };
  if (!(proration.monthDifference < 0)) return out;
  const stamp = Date.now();
  for (const invoiceId of proration.aheadInvoiceIds) {
    const credited = await creditAheadInvoice(exec, {
      organizationId,
      clientId: contract.client_id,
      contractId: contract.id,
      invoiceId,
      difference: -proration.monthDifference,
      description: `Plan change: ${proration.oldPlanName} -> ${proration.newPlanName}, month billed ahead`,
      createdBy: actorId,
      number: `PCN-C${contract.id}-I${invoiceId}-${stamp}`,
    });
    if (credited) {
      out.aheadCreditNoteIds.push(credited.creditNoteId);
      out.freed = money.round(out.freed + credited.freed);
    }
  }
  return out;
}

/**
 * After a plan change is committed: credit freed from months billed ahead
 * pays for further months at the new price. Never throws.
 */
async function extendAfterChange({ organizationId, clientId, actorId = null }) {
  return require('./billAheadService').billAheadQuietly({ orgId: organizationId, clientId, actorUserId: actorId });
}

module.exports = { prorate, prorationFor, issueProrationCreditNote, invoicedPeriods, creditAheadInvoice, creditAheadMonths, extendAfterChange };
