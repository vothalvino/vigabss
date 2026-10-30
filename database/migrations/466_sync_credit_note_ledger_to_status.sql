-- =============================================================================
-- Migration 466 — bring every credit note's ledger credit to its status
-- =============================================================================
-- Credit notes now follow one ledger invariant (creditNoteLedgerService):
--
--   net client_balance_ledger credit == the note's total while it is
--   issued/applied and not soft-deleted, and == 0 while it is draft,
--   cancelled or soft-deleted.
--
-- Those are exactly the notes the headline balance (clientBalanceService)
-- counts. Rows written before this release break it in three ways:
--   * an issued/applied note with no (or too little) credit — above all the
--     refund-path notes, which were inserted 'issued' with no ledger row —
--     makes the ledger read LESS in credit than the headline balance;
--   * a cancelled or soft-deleted note that kept its credit (no reversal was
--     ever written) makes it read MORE in credit;
--   * an issued note whose total was edited after it posted carries the old
--     total.
--
-- History is not edited. For every credit note whose net posted credit
-- differs from its target, append ONE row for the difference: a 'credit' when
-- the note is short (top-up), a 'debit' when it carries too much (reversal),
-- referencing the note exactly like every credit-note row (reference_type =
-- 'credit_note', reference_id = credit_notes.id, the note's client and org).
-- Notes without a client are skipped (the ledger needs one). Drafts were
-- already reversed by migration 465 and are at zero, so they match no row.
--
-- Not a double-count for refund-path notes: billing_adjustments (also written
-- by the refund path) is an audit record that no balance reads.
--
-- Idempotent: each appended row brings the note's net exactly to its target,
-- so a rerun finds no difference and inserts nothing. The signed expression is
-- ClientBalanceLedger.signedAmountSql (debit-type entry types and the debit
-- column count positive, everything else negative). Data-only: no DDL, so no
-- schema.sql change.
-- =============================================================================

INSERT INTO client_balance_ledger
  (client_id, organization_id, entry_type, amount, currency,
   reference_type, reference_id, description)
SELECT gap.client_id,
       gap.organization_id,
       CASE WHEN gap.diff > 0 THEN 'credit' ELSE 'debit' END,
       ABS(gap.diff),
       gap.currency,
       'credit_note',
       gap.id,
       LEFT(CONCAT(CASE WHEN gap.diff > 0 THEN 'Credit Note '
                        WHEN gap.target = 0 THEN 'Reversal: Credit Note '
                        ELSE 'Adjustment: Credit Note ' END,
                   COALESCE(NULLIF(gap.credit_note_number, ''), gap.id),
                   ' (ledger sync, migration 466)'), 255)
  FROM (
        SELECT cn.id,
               cn.client_id,
               cn.organization_id,
               cn.credit_note_number,
               COALESCE(cn.currency, posted.currency) AS currency,
               CASE WHEN cn.status IN ('issued', 'applied') AND cn.deleted_at IS NULL
                    THEN ROUND(cn.total, 2) ELSE 0 END AS target,
               ROUND((CASE WHEN cn.status IN ('issued', 'applied') AND cn.deleted_at IS NULL
                           THEN cn.total ELSE 0 END)
                     + COALESCE(posted.net, 0), 2) AS diff
          FROM credit_notes cn
          LEFT JOIN (
                SELECT l.reference_id,
                       l.client_id,
                       l.organization_id,
                       MAX(l.currency) AS currency,
                       SUM((CASE WHEN l.entry_type IN ('invoice', 'usage_deduction', 'debit')
                                 THEN l.amount ELSE -l.amount END) + l.debit - l.credit) AS net
                  FROM client_balance_ledger l
                 WHERE l.reference_type = 'credit_note'
                 GROUP BY l.reference_id, l.client_id, l.organization_id
               ) posted
            ON posted.reference_id = cn.id
           AND posted.client_id = cn.client_id
           AND posted.organization_id <=> cn.organization_id
         WHERE cn.client_id IS NOT NULL
       ) gap
 WHERE ABS(gap.diff) >= 0.005;
