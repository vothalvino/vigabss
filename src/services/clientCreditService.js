// =============================================================================
// VigaBSS 5.0 — Client credit: payments made ahead pay the next invoices
// =============================================================================
// A completed payment that is not (fully) allocated to invoices is credit on
// the client (clientBalanceService counts its remainder). It can come from a
// payment made ahead (staff, a reseller or collector, the portal), or from an
// invoice that was voided after it was paid. Until 2026-11 staff had to apply
// it by hand (POST /payments/:id/allocate-auto); now it pays the client's
// payable invoices on its own (owner decision, 2026-11-08):
//
//   • when the monthly run creates an invoice, before the invoice is emailed
//     or stamped, so a covered invoice is stamped PUE and needs no
//     Complemento de Pago (services/invoiceCfdiService.js picks PUE for a
//     paid invoice);
//   • when staff create an invoice by hand, unless they unticked "Use the
//     customer's credit" (POST /invoices apply_credit: false), which is kept
//     on the invoice (invoices.apply_client_credit = 0, migration 012) so
//     no automatic step ever applies credit to it;
//   • when a one-off invoice is created on its own transaction
//     (billingService.createOneOffInvoice);
//   • and as a sweep of every client at the start of the suspension run, so
//     nobody holding credit is suspended for an invoice it covers.
//
// applyCredit takes the client's payments with a remainder, oldest first,
// and runs the allocate-auto waterfall for each over the client's payable
// invoices in the payment's currency, oldest first — exactly what staff
// would do by hand, in one transaction that locks the payments, then the
// invoices (the order of allocate-auto and of a reseller void). After commit,
// best effort like the staff route: reconnect a suspended contract of an
// invoice that became paid, and the REP for an allocation to an invoice that
// already has a PPD CFDI. A paid invoice also books its reseller commission
// (paymentAllocationService.finalizeIfFullyPaid, inside the transaction).
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'clientCredit' });
const money = require('../utils/money');
const { requireOrgId } = require('../utils/requireOrgId');
const { inPlaceholders } = require('../utils/sqlBuild');
const paymentAllocationService = require('./paymentAllocationService');

const SWEEP_LIMIT = 500;

// The unallocated remainder of a payment row (amount - live allocations).
const REMAINDER_SQL = `(p.amount - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                          WHERE pa.payment_id = p.id AND pa.deleted_at IS NULL), 0))`;

/**
 * Apply a client's credit to its payable invoices.
 * @returns {Promise<{allocations: {payment_id:number, invoice_id:number, amount:number}[], applied: number, paid_invoice_ids: number[]}>}
 */
async function applyCredit({ orgId, clientId, actorUserId = null }) {
  requireOrgId(orgId, 'clientCreditService.applyCredit');
  const none = { allocations: [], applied: 0, paid_invoice_ids: [] };
  if (!clientId) return none;

  // A cheap read first: most clients have no credit, or nothing to pay.
  const [candidates] = await db.query(
    `SELECT p.id FROM payments p
      WHERE p.organization_id = ? AND p.client_id = ? AND p.status = 'completed' AND p.deleted_at IS NULL
        AND ${REMAINDER_SQL} > 0.005
      ORDER BY p.payment_date ASC, p.id ASC
      LIMIT 50`,
    [orgId, clientId],
  );
  if (!candidates || candidates.length === 0) return none;

  const conn = await db.getConnection();
  const exec = conn.execute.bind(conn);
  let posted;
  try {
    await conn.beginTransaction();
    // Lock order: the payments (ascending id), then the client's invoices.
    const ids = candidates.map((r) => Number(r.id)).sort((a, b) => a - b);
    const [payRows] = await exec(
      `SELECT p.*, ${REMAINDER_SQL} AS remainder FROM payments p
        WHERE p.organization_id = ? AND p.client_id = ? AND p.id IN (${inPlaceholders(ids)})
          AND p.status = 'completed' AND p.deleted_at IS NULL
        ORDER BY p.id ASC
        FOR UPDATE`,
      [orgId, clientId, ...ids],
    );
    await paymentAllocationService.lockInvoicesForAllocation(exec, orgId, { clientIds: [clientId] });

    // Oldest payment first.
    const payments = (payRows || [])
      .filter((p) => paymentAllocationService.isPaymentSettled(p) && Number(p.remainder) > 0.005)
      .sort((a, b) => (String(a.payment_date) < String(b.payment_date) ? -1 : String(a.payment_date) > String(b.payment_date) ? 1 : a.id - b.id));
    const allocations = [];
    const justPaid = new Map();
    for (const payment of payments) {
      // Fresh balances each time: this transaction sees its own allocations.
      // Not an invoice staff kept off credit (apply_client_credit = 0).
      const invoices = (await paymentAllocationService.getInvoicesWithBalance(exec, orgId, clientId, null, false))
        .filter((inv) => Number(inv.apply_client_credit ?? 1) !== 0)
        .filter((inv) => !paymentAllocationService.allocationRefusal(payment, inv));
      if (invoices.length === 0) continue;
      const out = await paymentAllocationService.allocateAcrossInvoices(exec, {
        payment, amount: money.round(Number(payment.remainder)), invoices,
      });
      for (const a of out.allocations) {
        allocations.push({ payment_id: Number(payment.id), invoice_id: Number(a.invoice_id), amount: money.round(a.amount) });
      }
      for (const inv of out.justPaidInvoices) justPaid.set(Number(inv.id), inv);
    }
    await conn.commit();
    posted = { allocations, justPaid: [...justPaid.values()] };
  } catch (err) {
    try { await conn.rollback(); } catch (_e) { /* keep the original error */ }
    throw err;
  } finally {
    conn.release();
  }

  if (posted.allocations.length === 0) return none;
  const applied = money.round(posted.allocations.reduce((t, a) => t + a.amount, 0));
  logger.info({ orgId, clientId, applied, allocations: posted.allocations.length }, 'Client credit applied to invoices');

  // Post-commit, best effort (as POST /payments/:id/allocate-auto).
  for (const invoice of posted.justPaid) {
    try {
      await paymentAllocationService.reconnectIfSuspended(invoice, actorUserId, orgId);
    } catch (err) {
      logger.error({ err, orgId, invoiceId: invoice.id }, 'Reconnect after applying client credit failed');
    }
  }
  const repService = require('./repService');
  for (const a of posted.allocations) {
    try {
      await repService.maybeGenerateRep(a.payment_id, a.invoice_id, a.amount, orgId, actorUserId);
    } catch (err) {
      logger.warn({ err: err.message, orgId, paymentId: a.payment_id, invoiceId: a.invoice_id }, 'REP after applying client credit failed');
    }
  }
  try {
    await require('./auditLog').log({
      userId: actorUserId,
      organizationId: orgId,
      action: 'client_credit_apply',
      tableName: 'payment_allocations',
      recordId: null,
      newValues: { client_id: Number(clientId), applied, allocations: posted.allocations },
    });
  } catch (err) {
    logger.warn({ err: err.message, orgId, clientId }, 'Audit of the applied client credit failed');
  }
  return { allocations: posted.allocations, applied, paid_invoice_ids: posted.justPaid.map((i) => Number(i.id)) };
}

/** applyCredit that never throws (for the hooks after an invoice is created). */
async function applyCreditQuietly(args) {
  try {
    return await applyCredit(args);
  } catch (err) {
    logger.error({ err, orgId: args.orgId, clientId: args.clientId }, 'Applying client credit failed; the sweep will retry');
    return { allocations: [], applied: 0, paid_invoice_ids: [], failed: true };
  }
}

/**
 * Every client of the organization that holds credit and has something to
 * pay: apply its credit. Runs at the start of the suspension run.
 */
async function sweepOrg(orgId, { actorUserId = null } = {}) {
  requireOrgId(orgId, 'clientCreditService.sweepOrg');
  const statuses = paymentAllocationService.PAYABLE_STATUSES;
  const [rows] = await db.query(
    `SELECT DISTINCT p.client_id FROM payments p
      WHERE p.organization_id = ? AND p.status = 'completed' AND p.deleted_at IS NULL
        AND ${REMAINDER_SQL} > 0.005
        AND EXISTS (SELECT 1 FROM invoices i
                     WHERE i.organization_id = p.organization_id AND i.client_id = p.client_id
                       AND i.deleted_at IS NULL AND i.apply_client_credit = 1
                       AND i.status IN (${inPlaceholders(statuses)}))
      LIMIT ${SWEEP_LIMIT}`,
    [orgId, ...statuses],
  );
  const out = { clients: 0, applied: 0, failed: 0 };
  for (const r of rows || []) {
    const res = await applyCreditQuietly({ orgId, clientId: Number(r.client_id), actorUserId });
    if (res.failed) out.failed += 1;
    else if (res.applied > 0) { out.clients += 1; out.applied = money.round(out.applied + res.applied); }
  }
  if (out.clients || out.failed) logger.info({ orgId, ...out }, 'Client credit sweep');
  return out;
}

module.exports = { applyCredit, applyCreditQuietly, sweepOrg, SWEEP_LIMIT };
