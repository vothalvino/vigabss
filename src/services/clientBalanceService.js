// =============================================================================
// VigaBSS 5.0 — Client Balance Service
// =============================================================================
// Computes a client's CURRENT account balance from source-of-truth billing
// data (invoices + payments) — NOT from client_balance_ledger.
//
// Why not the ledger: client_balance_ledger is written by SOME money paths
// (invoice generate, one-off invoice, payment record, credit note, refund)
// but not consistently ALL of them, and it has drifted in production — a
// client can have an open, unpaid invoice with NO ledger entry at all while
// an unrelated credit-note entry makes the ledger's running total read as a
// credit ("in credit" shown next to a genuinely unpaid invoice). The ledger
// stays exactly as it was — an audit trail / history view (GET
// /clients/:id/balance-ledger, GraphQL `Client.ledger`, the statement PDF) —
// this module is the SINGLE source for the headline "Account Balance" figure
// everywhere it is shown (GraphQL `Client.balance`/`balanceCurrency`, the AI
// support billing module, the support-context enrichment used by AI replies,
// and the client portal dashboard).
//
// balance = SUM(balance_due of payable invoices: issued/sent/overdue)
//         - SUM(unallocated remainder of completed payments: amount - allocated)
//         - SUM(total of standing credit notes: issued/applied)
//
// Credit notes are the ONE money instrument with no invoice/payment footprint
// at all — they historically reduced the balance only via their ledger entry,
// so a formula built purely on invoices+payments would silently drop a
// client's standing credit (adversarial review caught exactly this). Drafts
// (being prepared) and cancelled notes do NOT count — note this is *more*
// correct than the old ledger, which kept counting a credit note even after
// cancellation. Since migration 466 the ledger follows the same rule
// (creditNoteLedgerService): cancel/soft-delete append a reversal.
//
// Positive = owed by the client, negative = the client is in credit — same
// sign convention the ledger used (postpaid semantics: ClientDetail's own
// comment, preserved here).
//
// The formula is applied PER CURRENCY: an MXN invoice and a USD payment are
// not netted 1:1. Callers show `balances` when `mixedCurrency` is true.
// =============================================================================

const db = require('../config/database');
const Organization = require('../models/Organization');
const { getInvoicesWithBalance } = require('./paymentAllocationService');

// Payments in this status carry real, spendable money — pending/failed/
// cancelled/refunded payments never contributed a ledger credit either (see
// billingService.recordPaymentCredit, only ever called for a 'completed'
// payment) so they must not contribute to the computed balance.
const CREDITABLE_PAYMENT_STATUS = 'completed';

/**
 * Compute a client's current account balance, org-scoped, from invoices +
 * payments directly (see module doc for why not the ledger).
 *
 * @param {number} orgId
 * @param {number|string} clientId
 * @returns {Promise<{ balance: number|null, currency: string|null,
 *   balances: Array<{currency: string, balance: number}>, mixedCurrency: boolean }>}
 *   balance/currency are null when more than one currency contributes.
 */
async function computeClientBalance(orgId, clientId) {
  // Payable invoices (issued/sent/overdue) with a live, allocation-aware
  // balance_due — the exact same query/order POST /payments/:id/allocate-auto
  // and GET /clients/:id/open-invoices use, so this can never disagree with
  // what the payment waterfall would actually apply money to.
  const invoices = await getInvoicesWithBalance(db.query.bind(db), orgId, clientId, null, false);

  // Completed payments that still have money left unapplied to any invoice
  // (a client can overpay, or pay before an invoice exists) — that remainder
  // is a credit against the balance below.
  const [payments] = await db.query(
    `SELECT p.amount, p.currency,
            COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                       WHERE pa.payment_id = p.id AND pa.deleted_at IS NULL), 0) AS allocated
       FROM payments p
      WHERE p.client_id = ? AND p.organization_id = ? AND p.deleted_at IS NULL
        AND p.status = ?`,
    [clientId, orgId, CREDITABLE_PAYMENT_STATUS],
  );
  const unallocated = payments
    .map((p) => ({ currency: p.currency, remainder: parseFloat(p.amount) - parseFloat(p.allocated) }))
    // Ignore fully-allocated payments and sub-cent rounding noise — only a
    // genuine leftover credit should reduce the balance.
    .filter((p) => p.remainder > 0.005);

  // Standing credit notes — see module doc. 'issued'/'applied' = live credit
  // on the account; 'draft' is still being prepared and 'cancelled' is voided.
  // The part applied to an invoice already lowered that invoice's balance_due
  // (BIL-14); only the rest stands as credit.
  const [creditNotes] = await db.query(
    `SELECT cn.total, cn.currency,
            COALESCE((SELECT SUM(cna.amount) FROM credit_note_applications cna
                       WHERE cna.credit_note_id = cn.id AND cna.deleted_at IS NULL), 0) AS applied
       FROM credit_notes cn
      WHERE cn.client_id = ? AND cn.organization_id = ? AND cn.deleted_at IS NULL
        AND cn.status IN ('issued', 'applied')`,
    [clientId, orgId],
  );
  const standingCredits = creditNotes
    .map((cn) => ({ currency: cn.currency, total: parseFloat(cn.total) - parseFloat(cn.applied || 0) }))
    .filter((cn) => cn.total > 0.005);

  // Amounts in different currencies are never added together (GQL-10). Each
  // currency gets its own figure; a single headline number exists only when
  // one currency contributes. With several, `balance` and `currency` are
  // null and `mixedCurrency` tells the caller to show `balances` instead.
  const byCurrency = new Map();
  const add = (cur, amount) => byCurrency.set(cur, (byCurrency.get(cur) || 0) + amount);
  for (const inv of invoices) {
    const due = parseFloat(inv.balance_due);
    if (due > 0.005) add(inv.currency, due);
  }
  for (const p of unallocated) add(p.currency, -p.remainder);
  for (const cn of standingCredits) add(cn.currency, -cn.total);

  const balances = [...byCurrency.entries()]
    .map(([cur, amount]) => ({ currency: cur, balance: Math.round(amount * 100) / 100 }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  if (balances.length > 1) {
    return { balance: null, currency: null, balances, mixedCurrency: true };
  }
  if (balances.length === 1) {
    return { balance: balances[0].balance, currency: balances[0].currency, balances, mixedCurrency: false };
  }
  // Nothing contributes: a zero balance in the organization's currency.
  const currency = await Organization.getCurrency(orgId);
  return { balance: 0, currency, balances: [], mixedCurrency: false };
}

module.exports = { computeClientBalance };
