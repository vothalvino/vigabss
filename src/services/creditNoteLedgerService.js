// =============================================================================
// VigaBSS 5.0 — Credit Note Ledger Service
// =============================================================================
// One invariant for every path that creates or changes a credit note:
//
//   net client_balance_ledger credit for a note == its total while it is
//   issued/applied (and not soft-deleted), and == 0 when it is draft,
//   cancelled or soft-deleted.
//
// Those are exactly the notes clientBalanceService counts toward the headline
// balance, so keeping the ledger at this target keeps the ledger's running
// balance (Ledger tab, GET /clients/:id/balance-ledger, statement PDF) in step
// with the headline figure.
//
// The ledger is append-only: moving a note to its target always APPENDS one
// 'credit' or 'debit' row for the difference, referencing the note exactly like
// every credit-note row (reference_type = 'credit_note', reference_id = the
// note's id, the note's client and org). History is never updated or deleted.
//
// Callers must hold the note's row lock (or have just inserted it) on the same
// executor: the read of the current net and the append are then serialized
// against any concurrent writer, so a duplicate request sees the first one's
// row and posts nothing.
// =============================================================================

const ClientBalanceLedger = require('../models/ClientBalanceLedger');

// The statuses clientBalanceService counts as standing credit.
const POSTED_STATUSES = new Set(['issued', 'applied']);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * The net ledger credit this note must carry under the invariant.
 *
 * @param {{status: string, total: number|string, deleted_at?: unknown}} note
 * @returns {number}
 */
function ledgerTarget(note) {
  if (!note || note.deleted_at) return 0;
  return POSTED_STATUSES.has(note.status) ? round2(note.total) : 0;
}

/**
 * Net credit currently posted for this note to its client (positive = credit).
 */
async function postedCredit(exec, note, orgId) {
  const [rows] = await exec(
    `SELECT COALESCE(SUM(${ClientBalanceLedger.signedAmountSql}), 0) AS net
       FROM client_balance_ledger
      WHERE reference_type = 'credit_note' AND reference_id = ?
        AND client_id = ? AND organization_id <=> ?`,
    [note.id, note.client_id, orgId],
  );
  // The signed sum is positive for debits, so the credit posted is -net.
  return round2(-(Number(rows?.[0]?.net) || 0));
}

function describe(note, diff, target, label) {
  const name = `Credit Note ${note.credit_note_number || note.id}`;
  if (diff > 0) return target > 0 && label ? `${name} (${label})` : name;
  if (target <= 0) return `Reversal: ${name}${label ? ` (${label})` : ''}`;
  return `Adjustment: ${name}${label ? ` (${label})` : ''}`;
}

/**
 * Bring this note's net ledger credit to `target` (default: ledgerTarget(note))
 * by appending one compensating row for the difference. Posts nothing when the
 * net already matches, so it is safe to call on every write.
 *
 * @param {Function} exec  executor bound to the caller's transaction
 * @param {object}   note  credit_notes row (id, client_id, total, status, ...)
 * @param {number|null} orgId
 * @param {{target?: number, label?: string}} [opts]
 *        target: override (e.g. 0 when the note is being soft-deleted in this
 *        transaction); label: short reason appended to the row description.
 * @returns {Promise<number>} the signed credit appended (0 when nothing posted)
 */
async function syncCreditNoteLedger(exec, note, orgId, opts = {}) {
  if (!note || !note.client_id) return 0;
  const target = opts.target !== undefined ? round2(opts.target) : ledgerTarget(note);
  const credited = await postedCredit(exec, note, orgId);
  const diff = round2(target - credited);
  if (Math.abs(diff) < 0.005) return 0;
  await exec(
    `INSERT INTO client_balance_ledger (client_id, organization_id, entry_type, amount, currency, reference_type, reference_id, description)
     VALUES (?, ?, ?, ?, ?, 'credit_note', ?, ?)`,
    [note.client_id, orgId, diff > 0 ? 'credit' : 'debit', Math.abs(diff), note.currency || null,
      note.id, describe(note, diff, target, opts.label).slice(0, 255)],
  );
  return diff;
}

module.exports = { POSTED_STATUSES, ledgerTarget, syncCreditNoteLedger };
