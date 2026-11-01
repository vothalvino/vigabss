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

/**
 * SQL that is true when the invoice aliased `alias` is NOT being paid off
 * under an active payment plan (BIL-17). Suspension and late fees skip an
 * invoice the client is paying in installments.
 * @param {string} [alias]
 * @returns {string}
 */
function notUnderActivePlanSql(alias = 'i') {
  return `NOT EXISTS (SELECT 1 FROM payment_plan_installments ppi
                        JOIN payment_plans pp ON pp.id = ppi.plan_id
                       WHERE ppi.invoice_id = ${alias}.id AND pp.status = 'active' AND pp.deleted_at IS NULL)`;
}

module.exports = { creditAppliedSql, notUnderActivePlanSql };
