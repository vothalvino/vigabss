// =============================================================================
// VigaBSS 5.0 — What still reduces an invoice besides payments
// =============================================================================
// An invoice's open balance is its total minus the live payment allocations
// and minus the live credit-note applications (migration 484, BIL-14). Every
// open-balance calculation appends this fragment next to its allocation sum,
// so a credited invoice stops being charged, dunned or suspended for the
// credited part.
// =============================================================================

/**
 * SQL for the credit applied to the invoice aliased `alias` (default `i`).
 * @param {string} [alias]
 * @returns {string}
 */
function creditAppliedSql(alias = 'i') {
  return `COALESCE((SELECT SUM(cna.amount) FROM credit_note_applications cna
                     WHERE cna.invoice_id = ${alias}.id AND cna.deleted_at IS NULL), 0)`;
}

module.exports = { creditAppliedSql };
