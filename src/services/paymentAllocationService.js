// =============================================================================
// VigaBSS 5.0 — Payment Allocation Service
// =============================================================================
// Every writer of payment_allocations goes through applyAllocation (BIL-28):
// POST /payments/:id/allocate, allocate-auto and reallocate, gateway
// reconciliation, payment plans and group billing. It refuses an allocation
// across organizations, clients or currencies, or to an invoice that is not
// payable, maps the guard triggers to 422s, and marks a fully covered invoice
// paid. tests/paymentAllocationWriters.test.js fails on a new raw INSERT.
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
const { AppError } = require('../utils/errors');
const money = require('../utils/money');

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
 * Lock the invoice rows an allocation will touch, with a plain locking read
 * and nothing else (DAL-04). Call it right after locking the payment and
 * BEFORE any read that sums allocations.
 *
 * The over-allocation triggers and every balance_due here sum
 * payment_allocations with non-locking reads, and MySQL does not lock the
 * rows of a subquery for an outer FOR UPDATE. Under REPEATABLE READ the
 * transaction's snapshot is fixed by its first non-locking read, so a sum
 * read before the parent rows were locked could miss an allocation another
 * transaction committed while this one waited. Two allocators could then both
 * pass, and one payment settled two invoices, or one invoice collected two
 * payments. With the payment and its invoices locked first (always payment,
 * then invoices in id order), concurrent allocators serialize and each one's
 * snapshot starts after the previous committed.
 *
 * @param {Function} exec - bound query function on the open transaction
 * @param {number|null} orgId
 * @param {{invoiceIds?: number[], clientIds?: number[]}} which
 */
async function lockInvoicesForAllocation(exec, orgId, { invoiceIds = [], clientIds = [] } = {}) {
  const ids = invoiceIds.filter((v) => v !== null && v !== undefined);
  const clients = clientIds.filter((v) => v !== null && v !== undefined);
  if (ids.length === 0 && clients.length === 0) return;
  const where = [
    ids.length ? `id IN (${ids.map(() => '?').join(', ')})` : null,
    clients.length ? `client_id IN (${clients.map(() => '?').join(', ')})` : null,
  ].filter(Boolean).join(' OR ');
  await exec(
    `SELECT id FROM invoices WHERE organization_id <=> ? AND (${where}) ORDER BY id FOR UPDATE`,
    [orgId, ...ids, ...clients],
  );
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

const sameCurrency = (a, b) => !a || !b || String(a).toUpperCase() === String(b).toUpperCase();

/**
 * Why `payment` may not settle `invoice`, or null when it may.
 * @param {{organization_id:number, client_id:number, currency?:string}} payment
 * @param {{organization_id?:number, client_id:number, currency?:string, status:string}} invoice
 * @param {{ anyClient?: boolean }} [opts] anyClient: group billing, where the
 *   group primary's payment settles its members' invoices.
 * @returns {{code:string, message:string}|null}
 */
function allocationRefusal(payment, invoice, { anyClient = false } = {}) {
  if (invoice.organization_id !== undefined && Number(invoice.organization_id) !== Number(payment.organization_id)) {
    return { code: 'NOT_FOUND', message: 'Invoice not found.' };
  }
  if (!PAYABLE_STATUSES.includes(invoice.status)) {
    return { code: 'INVOICE_NOT_PAYABLE', message: `Cannot apply a payment to a ${invoice.status} invoice.` };
  }
  if (!anyClient && Number(invoice.client_id) !== Number(payment.client_id)) {
    return { code: 'CROSS_CLIENT_ALLOCATION', message: 'The invoice belongs to a different client than the payment.' };
  }
  if (!sameCurrency(payment.currency, invoice.currency)) {
    return {
      code: 'CURRENCY_MISMATCH',
      message: `A ${payment.currency} payment cannot settle a ${invoice.currency} invoice.`,
    };
  }
  return null;
}

/**
 * Insert one allocation inside the caller's open transaction and mark the
 * invoice paid once fully covered. Throws a 422 AppError when the allocation
 * is refused, would exceed the invoice or payment (guard trigger), or
 * duplicates a live allocation of the same pair. finalize: false leaves the
 * paid status to the caller (reallocation re-derives both invoices after
 * commit; the single-invoice route reads the row back first).
 * @returns {Promise<{ id: number, becamePaid: boolean }>}
 */
async function applyAllocation(exec, { payment, invoice, amount, anyClient = false, finalize = true }) {
  const refusal = allocationRefusal(payment, invoice, { anyClient });
  if (refusal) throw new AppError(refusal.message, refusal.code === 'NOT_FOUND' ? 404 : 422, refusal.code);
  let result;
  try {
    [result] = await exec(
      'INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)',
      [payment.id, invoice.id, amount],
    );
  } catch (err) {
    if (isOverAllocationError(err)) {
      throw new AppError('Allocation would exceed the invoice or payment total.', 422, 'OVER_ALLOCATION');
    }
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      throw new AppError('This payment is already applied to that invoice.', 422, 'ALLOCATION_EXISTS');
    }
    throw err;
  }
  const becamePaid = finalize ? await finalizeIfFullyPaid(exec, invoice) : false;
  return { id: result.insertId, becamePaid };
}

/**
 * Apply up to `amount` of a payment across the given invoice rows, oldest/**
 * Apply up to `amount` of a payment across the given invoice rows, oldest
 * first (the rows' order), inside the caller's open transaction. Each invoice
 * receives min(remainder, live balance_due); a fully covered invoice is
 * finalized paid. Whatever is left stays as unallocated credit on the
 * payment. Shared by POST /payments/:id/allocate-auto (staff) and gateway
 * reconciliation (paymentGatewayService.reconcilePayment) so both post money
 * the same way.
 *
 * A second live allocation of the same payment to the same invoice (the
 * soft-delete-aware UNIQUE, migration 361) is skipped. Any other refusal
 * (applyAllocation's 422s, including over-allocation) is thrown for the
 * caller to roll back. Callers pass only invoices in the payment's currency.
 *
 * @param {Function} exec - bound query function on the open transaction
 * @param {object} params
 * @param {{id:number, organization_id:number, client_id:number, currency?:string}} params.payment
 * @param {number|string} params.amount - the payment's unallocated remainder
 * @param {object[]} params.invoices - rows from getInvoicesWithBalance(..., forUpdate=true)
 * @returns {Promise<{allocations: object[], justPaidInvoices: object[], remainder: number}>}
 */
async function allocateAcrossInvoices(exec, { payment, amount, invoices }) {
  // Whole cents (BIL-31): the remainder is carried exactly, never as a float.
  let remainder = money.round(amount);
  const allocations = [];
  const justPaidInvoices = [];
  for (const invoice of invoices) {
    if (remainder <= 0) break;

    const balanceDue = Math.max(0, money.round(invoice.balance_due));
    if (balanceDue <= 0) continue; // already fully covered — skip, don't insert a zero row

    const applyAmount = Math.min(remainder, balanceDue);
    if (applyAmount <= 0) continue;

    let applied;
    try {
      applied = await applyAllocation(exec, { payment, invoice, amount: applyAmount });
    } catch (err) {
      // Already allocated live from this payment (e.g. allocate-auto called
      // twice with overlapping invoice_ids): the earlier row covers it.
      if (err.code === 'ALLOCATION_EXISTS') continue;
      throw err;
    }

    allocations.push({
      id: applied.id, payment_id: payment.id, invoice_id: invoice.id,
      invoice_number: invoice.invoice_number, amount: applyAmount,
    });
    remainder = money.sub(remainder, applyAmount);
    if (applied.becamePaid) justPaidInvoices.push(invoice);
  }
  return { allocations, justPaidInvoices, remainder };
}

/** True for the over-allocation guard trigger's SIGNAL (migration 126). */
function isOverAllocationError(err) {
  return Boolean(err) && (err.sqlState === '45000' || err.errno === 1644);
}

module.exports = {
  lockInvoicesForAllocation,
  PAYABLE_STATUSES,
  isPaymentSettled,
  paymentNotSettledError,
  finalizeIfFullyPaid,
  reconnectIfSuspended,
  getInvoicesWithBalance,
  allocationRefusal,
  applyAllocation,
  allocateAcrossInvoices,
  isOverAllocationError,
};
