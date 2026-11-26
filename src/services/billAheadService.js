'use strict';

// =============================================================================
// Paying ahead bills ahead
// =============================================================================
// Money a client pays beyond what it owes used to wait as credit until each
// month's run created an invoice for it to pay. The money was collected in
// one month and invoiced in later ones, which is wrong for a taxpayer whose
// income counts when it is collected, and left a credit nobody had invoiced.
//
// Now the credit is invoiced when it arrives: the client's next billing
// periods are invoiced one after another, at today's price, and the credit
// pays each as it is created, until none is left. A fully covered month is an
// ordinary paid invoice (stamped PUE when the organization stamps
// automatically, or left for the period's factura global). The last one may
// be partly paid: what is left of the money is a payment on account of that
// month, and the invoice shows what is still owed.
//
// When one of those months arrives, the monthly run finds its period already
// invoiced and does nothing.
//
// Not billed ahead:
//   - a contract in its trial (the price of later months is not today's);
//   - a plan that charges data overage (the usage of a future month is unknown);
//   - more than MAX_PERIODS_AHEAD months.
// For those the credit waits, as before, and pays the invoices as they come.
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'billAhead' });
const money = require('../utils/money');
const { requireOrgId } = require('../utils/requireOrgId');
const { withAdvisoryLock } = require('../utils/advisoryLock');
const { businessToday } = require('../utils/businessDate');
const billingService = require('./billingService');
const clientCreditService = require('./clientCreditService');

const MAX_PERIODS_AHEAD = 24;
const SWEEP_LIMIT = 500;

// The unallocated remainder of a payment row (amount - live allocations).
const REMAINDER_SQL = `(p.amount - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                          WHERE pa.payment_id = p.id AND pa.deleted_at IS NULL), 0))`;

/** The client's credit: what its completed payments have not paid yet, by currency. */
async function creditByCurrency(orgId, clientId) {
  const [rows] = await db.query(
    `SELECT p.currency, SUM(${REMAINDER_SQL}) AS credit FROM payments p
      WHERE p.organization_id = ? AND p.client_id = ? AND p.status = 'completed' AND p.deleted_at IS NULL
        AND ${REMAINDER_SQL} > 0.005
      GROUP BY p.currency`,
    [orgId, clientId],
  );
  return new Map((rows || []).map((r) => [r.currency, money.round(Number(r.credit))]));
}

/** The client's contracts that can be invoiced ahead, with their plan. */
async function contractsToBillAhead(orgId, clientId) {
  const [rows] = await db.query(
    `SELECT c.*, p.name AS plan_name, p.price AS plan_price, p.currency AS plan_currency,
            p.trial_days AS plan_trial_days, p.overage_mode AS plan_overage_mode
       FROM contracts c
       JOIN plans p ON p.id = c.plan_id AND p.organization_id <=> c.organization_id
       JOIN clients cl ON cl.id = c.client_id AND cl.organization_id <=> c.organization_id AND cl.deleted_at IS NULL
      WHERE c.organization_id = ? AND c.client_id = ? AND c.status = 'active' AND c.deleted_at IS NULL
      ORDER BY c.id ASC`,
    [orgId, clientId],
  );
  return (rows || []).filter((c) => {
    if (c.plan_overage_mode === 'per_gb') return false;
    if (billingService.isContractInTrial(c, { trial_days: c.plan_trial_days })) return false;
    return Number(c.price_override ?? c.plan_price) > 0;
  });
}

const dayOf = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

/**
 * Invoice the client's coming months with the credit it holds.
 * @returns {Promise<{invoices: {id:number, invoice_number:string, contract_id:number, period_start:string, period_end:string, total:number, paid:boolean}[], applied:number, ran:boolean}>}
 */
async function billAhead({ orgId, clientId, actorUserId = null }) {
  requireOrgId(orgId, 'billAheadService.billAhead');
  const out = { invoices: [], applied: 0, ran: false };
  if (!clientId) return out;

  // One at a time per client: two runs at once could each invoice a month for
  // the same money.
  await withAdvisoryLock(`bill-ahead:${orgId}:${clientId}`, async () => {
    out.ran = true;
    // What the client already owes comes first.
    const first = await clientCreditService.applyCredit({ orgId, clientId, actorUserId });
    out.applied = money.round(out.applied + first.applied);

    const contracts = await contractsToBillAhead(orgId, clientId);
    if (contracts.length === 0) return;
    const orgCurrency = await require('../models/Organization').getCurrency(orgId);
    const today = businessToday();

    for (let i = 0; i < MAX_PERIODS_AHEAD; i += 1) {
      const credit = await creditByCurrency(orgId, clientId);
      if (credit.size === 0) break;

      // The next period of each contract; the one that starts first is next.
      const next = [];
      for (const contract of contracts) {
        const currency = contract.plan_currency || orgCurrency;
        if (!((credit.get(currency) || 0) > 0.005)) continue;
        const period = await billingService.generateBillingPeriod(contract);
        if (period && period.status === 'pending') next.push({ contract, period });
      }
      if (next.length === 0) break;
      next.sort((a, b) => (dayOf(a.period.period_start) < dayOf(b.period.period_start) ? -1
        : dayOf(a.period.period_start) > dayOf(b.period.period_start) ? 1 : a.contract.id - b.contract.id));
      const { contract, period } = next[0];

      const plan = { name: contract.plan_name, price: contract.plan_price, currency: contract.plan_currency };
      const invoice = await billingService.generateInvoice(period, contract, plan, orgId);
      // Invoiced before its own month was due: a month billed ahead.
      const ahead = dayOf(period.scheduled_at) > today;
      if (ahead) {
        await db.query(
          'UPDATE invoices SET billed_ahead = 1 WHERE id = ? AND organization_id = ?',
          [invoice.id, orgId],
        );
      }
      const paid = await clientCreditService.applyCredit({ orgId, clientId, actorUserId });
      out.applied = money.round(out.applied + paid.applied);
      out.invoices.push({
        id: Number(invoice.id), invoice_number: invoice.invoice_number, contract_id: Number(contract.id),
        period_start: dayOf(period.period_start), period_end: dayOf(period.period_end),
        total: money.round(Number(invoice.total)), paid: paid.paid_invoice_ids.includes(Number(invoice.id)),
        billed_ahead: ahead,
      });
      // Stamped now when the organization stamps automatically: the money is
      // collected today, so its CFDI is today's.
      try {
        await require('./invoiceCfdiService').autoStampInvoice(invoice.id, orgId);
      } catch (err) {
        logger.warn({ err: err.message, orgId, invoiceId: invoice.id }, 'Stamping an invoice billed ahead failed');
      }
      // Nothing was applied: the credit cannot pay this client's invoices
      // (another currency, a refused payment). Stop rather than invoice more.
      if (!(paid.applied > 0)) break;
    }
  });

  if (out.invoices.length) {
    logger.info({ orgId, clientId, invoices: out.invoices.length, applied: out.applied }, 'Credit invoiced ahead');
    try {
      await require('./auditLog').log({
        userId: actorUserId,
        organizationId: orgId,
        action: 'bill_ahead',
        tableName: 'invoices',
        recordId: null,
        newValues: { client_id: Number(clientId), invoice_ids: out.invoices.map((inv) => inv.id), applied: out.applied },
      });
    } catch (err) {
      logger.warn({ err: err.message, orgId, clientId }, 'Audit of invoices billed ahead failed');
    }
  }
  return out;
}

/** billAhead that never throws (for the hooks after a payment is recorded). */
async function billAheadQuietly(args) {
  try {
    return await billAhead(args);
  } catch (err) {
    logger.error({ err, orgId: args.orgId, clientId: args.clientId }, 'Billing ahead failed; the daily sweep will retry');
    return { invoices: [], applied: 0, ran: false, failed: true };
  }
}

/**
 * Every client of the organization still holding credit: invoice its coming
 * months. Catches credit that arrived by a path with no hook of its own (an
 * online payment, an invoice voided after it was paid).
 */
async function sweepOrg(orgId, { actorUserId = null } = {}) {
  requireOrgId(orgId, 'billAheadService.sweepOrg');
  const [rows] = await db.query(
    `SELECT DISTINCT p.client_id FROM payments p
      WHERE p.organization_id = ? AND p.status = 'completed' AND p.deleted_at IS NULL
        AND ${REMAINDER_SQL} > 0.005
      LIMIT ${SWEEP_LIMIT}`,
    [orgId],
  );
  const out = { clients: 0, invoices: 0, failed: 0 };
  for (const r of rows || []) {
    const res = await billAheadQuietly({ orgId, clientId: Number(r.client_id), actorUserId });
    if (res.failed) out.failed += 1;
    else if (res.invoices.length) { out.clients += 1; out.invoices += res.invoices.length; }
  }
  if (out.clients || out.failed) logger.info({ orgId, ...out }, 'Bill-ahead sweep');
  return out;
}

module.exports = { billAhead, billAheadQuietly, sweepOrg, creditByCurrency, contractsToBillAhead, MAX_PERIODS_AHEAD };
