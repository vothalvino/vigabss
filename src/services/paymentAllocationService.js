// =============================================================================
// VigaBSS 5.0 — Payment Allocation Service
// =============================================================================
// Shared logic between POST /payments/:id/allocate (single invoice, kept for
// API compatibility) and POST /payments/:id/allocate-auto (FIFO oldest→newest,
// multi-invoice waterfall). Both routes call the SAME "mark a fully-covered
// invoice paid + reconnect a suspended contract" logic and the SAME "client's
// payable invoices with a live balance_due" query, so the two endpoints
// cannot drift out of sync with each other (see PR brief "payment waterfall").
//
// invoices.status has NO 'partial'/'partially_paid' value in the ENUM
// (database/schema.sql) — a partially-allocated invoice is intentionally left
// in its current status (issued/sent/overdue); only a FULLY covered invoice
// flips to 'paid'. Do not invent an enum value here.
// =============================================================================

const db = require('../config/database');
const suspensionService = require('./suspensionService');
const { requireOrgId } = require('../utils/requireOrgId');
const { creditAppliedSql } = require('../utils/invoiceBalance');

// Invoices in these statuses can receive a payment allocation. Mirrors the
// frontend's NON_PAYABLE_STATUSES set (frontend/src/pages/payments/
// PaymentActions.tsx: void/cancelled/paid/draft excluded) — keep both in sync.
const PAYABLE_STATUSES = ['issued', 'sent', 'overdue'];

// Only money that actually arrived may settle an invoice. A pending, failed,
// refunded or cancelled payment applied to an invoice marked it paid,
// reconnected service and stamped a REP for money that never landed.
function paymentNotSettledError(payment) {
  return {
    code: 'PAYMENT_NOT_SETTLED',
    message: `Only a completed payment can be applied to invoices (this payment is ${payment.status}).`,
  };
}

function isPaymentSettled(payment) {
  return payment?.status === 'completed';
}

/**
 * Recompute an invoice's live allocated total and flip it to 'paid' (+paid_at)
 * once fully covered. Takes a bound query FUNCTION — e.g. `conn.execute.bind(conn)`
 * inside an open allocate-auto transaction, or `db.query.bind(db)` for the
 * standalone single-allocate route — NOT a conn/db object (see
 * suspensionService.logSuspensionEvent's header comment for why: mocked test
 * doubles for conn vs db assert on different methods).
 *
 * SQL/param shape (`UPDATE invoices SET status = ?, paid_at = NOW() WHERE id = ?`,
 * `['paid', invoice.id]`) intentionally matches what POST /:id/allocate has
 * always issued — existing tests assert on it.
 *
 * @param {Function} exec - bound query function: (sql, params) => Promise
 * @param {{id:number, total:string|number}} invoice
 * @returns {Promise<boolean>} true if this call just marked it paid
 */
async function finalizeIfFullyPaid(exec, invoice) {
  const [allocRows] = await exec(
    // Credit applied to the invoice counts toward settling it (BIL-14).
    `SELECT SUM(amount) AS total_allocated FROM payment_allocations WHERE invoice_id = ? AND deleted_at IS NULL
     UNION ALL
     SELECT SUM(amount) FROM credit_note_applications WHERE invoice_id = ? AND deleted_at IS NULL`,
    [invoice.id, invoice.id],
  );
  const totalAllocated = allocRows.reduce((sum, r) => sum + parseFloat(r.total_allocated || 0), 0);
  if (totalAllocated < parseFloat(invoice.total)) return false;
  await exec(
    'UPDATE invoices SET status = ?, paid_at = NOW() WHERE id = ?',
    ['paid', invoice.id],
  );
  return true;
}

/**
 * If the invoice's contract is currently suspended, reconnect it. Always call
 * this AFTER the allocation transaction commits — reconnectContract opens and
 * manages its OWN connection/transaction (RADIUS CoA, suspension_logs) and
 * cannot join an outer one. Matches the pre-existing single-allocate route's
 * behaviour and billingService.refreshInvoicePaidStatus's "outside the
 * transaction — reads committed state" convention (see reallocate route).
 *
 * The contract is looked up in the CALLER'S organization and must belong to
 * the invoice's own client. An invoice can carry a contract_id written before
 * the create/update paths verified it, so the invoice row alone is not proof
 * that its contract is ours: unscoped, paying an org-A invoice reconnected an
 * org-B suspended contract (BIL-04). reconnectContract is handed the org too,
 * so its own lock/UPDATE are bound the same way.
 *
 * @param {{id:number, client_id:number, contract_id:number|null}} invoice
 * @param {number} userId
 * @param {number|null} orgId - the caller's org (req.orgId); undefined throws
 * @returns {Promise<boolean>} true if a reconnect was actually performed
 */
async function reconnectIfSuspended(invoice, userId, orgId) {
  requireOrgId(orgId, 'paymentAllocationService.reconnectIfSuspended');
  if (!invoice.contract_id) return false;
  const [contractRows] = await db.query(
    `SELECT * FROM contracts
      WHERE id = ? AND organization_id <=> ? AND client_id = ?
        AND status = ? AND deleted_at IS NULL`,
    [invoice.contract_id, orgId, invoice.client_id, 'suspended'],
  );
  if (!contractRows[0]) return false;
  await suspensionService.reconnectContract(invoice.contract_id, userId, invoice.id, { orgId });
  return true;
}

/**
 * A client's invoices with a computed, live balance_due, oldest issue_date
 * first (ties broken by id) — the FIFO waterfall order. Shared by
 * GET /clients/:id/open-invoices (frontend checklist display) and
 * POST /payments/:id/allocate-auto (both the "no invoice_ids given → all
 * payable invoices" branch and the "invoice_ids given → org+client-verified
 * subset" branch), so the order the checklist shows always matches the order
 * money is actually applied in, and a caller-supplied invoice_id that isn't
 * in this result is provably missing / wrong org / wrong client / not payable.
 *
 * @param {Function} exec - bound query function. Pass `conn.execute.bind(conn)`
 *   from inside an allocate-auto transaction with `forUpdate: true` so the
 *   invoice rows are locked for the duration of the allocation; pass
 *   `db.query.bind(db)` for a plain read (the GET display endpoint).
 * @param {number} orgId
 * @param {number} clientId
 * @param {number[]|null} [invoiceIds] - restrict to these ids; null/undefined = all payable invoices
 * @param {boolean} [forUpdate] - append FOR UPDATE (only valid inside a transaction)
 */
async function getInvoicesWithBalance(exec, orgId, clientId, invoiceIds, forUpdate) {
  const statusPlaceholders = PAYABLE_STATUSES.map(() => '?').join(', ');
  const idFilter = invoiceIds && invoiceIds.length
    ? `AND i.id IN (${invoiceIds.map(() => '?').join(', ')})`
    : '';
  const [rows] = await exec(
    `SELECT i.*,
            (i.total - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                                   WHERE pa.invoice_id = i.id AND pa.deleted_at IS NULL), 0)
                     - ${creditAppliedSql('i')}) AS balance_due
       FROM invoices i
      WHERE i.client_id = ? AND i.organization_id = ? AND i.deleted_at IS NULL
        AND i.status IN (${statusPlaceholders}) ${idFilter}
      ORDER BY i.issue_date ASC, i.id ASC
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [clientId, orgId, ...PAYABLE_STATUSES, ...(invoiceIds || [])],
  );
  return rows;
}

/**
 * Apply up to `amount` of a payment across the given invoice rows, oldest
 * first (the rows' order), inside the caller's open transaction. Each invoice
 * receives min(remainder, live balance_due); a fully covered invoice is
 * finalized paid. Whatever is left stays as unallocated credit on the
 * payment. Shared by POST /payments/:id/allocate-auto (staff) and gateway
 * reconciliation (paymentGatewayService.reconcilePayment) so both post money
 * the same way.
 *
 * A second live allocation of the same payment to the same invoice (the
 * soft-delete-aware UNIQUE, migration 361) is skipped. Any other error,
 * including the over-allocation guard trigger (SQLSTATE 45000), is rethrown
 * for the caller to map and roll back.
 *
 * @param {Function} exec - bound query function on the open transaction
 * @param {object} params
 * @param {number} params.paymentId
 * @param {number|string} params.amount - the payment's unallocated remainder
 * @param {object[]} params.invoices - rows from getInvoicesWithBalance(..., forUpdate=true)
 * @returns {Promise<{allocations: object[], justPaidInvoices: object[], remainder: number}>}
 */
async function allocateAcrossInvoices(exec, { paymentId, amount, invoices }) {
  let remainder = Math.round(Number(amount) * 100) / 100;
  const allocations = [];
  const justPaidInvoices = [];
  for (const invoice of invoices) {
    if (remainder <= 0) break;

    const balanceDue = Math.max(0, Math.round(Number(invoice.balance_due) * 100) / 100);
    if (balanceDue <= 0) continue; // already fully covered — skip, don't insert a zero row

    const applyAmount = Math.round(Math.min(remainder, balanceDue) * 100) / 100;
    if (applyAmount <= 0) continue;

    let insertResult;
    try {
      [insertResult] = await exec(
        'INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)',
        [paymentId, invoice.id, applyAmount],
      );
    } catch (allocErr) {
      // Already allocated live from this payment (e.g. allocate-auto called
      // twice with overlapping invoice_ids): the earlier row covers it.
      if (allocErr.code === 'ER_DUP_ENTRY' || allocErr.errno === 1062) continue;
      throw allocErr;
    }

    allocations.push({
      id: insertResult.insertId, payment_id: paymentId, invoice_id: invoice.id,
      invoice_number: invoice.invoice_number, amount: applyAmount,
    });
    remainder = Math.round((remainder - applyAmount) * 100) / 100;

    const becamePaid = await finalizeIfFullyPaid(exec, invoice);
    if (becamePaid) justPaidInvoices.push(invoice);
  }
  return { allocations, justPaidInvoices, remainder };
}

/** True for the over-allocation guard trigger's SIGNAL (migration 126). */
function isOverAllocationError(err) {
  return Boolean(err) && (err.sqlState === '45000' || err.errno === 1644);
}

module.exports = {
  PAYABLE_STATUSES,
  isPaymentSettled,
  paymentNotSettledError,
  finalizeIfFullyPaid,
  reconnectIfSuspended,
  getInvoicesWithBalance,
  allocateAcrossInvoices,
  isOverAllocationError,
};
