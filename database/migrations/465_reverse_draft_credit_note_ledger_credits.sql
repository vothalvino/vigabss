-- =============================================================================
-- Migration 465 — reverse create-time ledger credits on draft credit notes
-- =============================================================================
-- POST /credit-notes used to write a client_balance_ledger 'credit' for every
-- new note with a total, whatever its status. A credit note now posts only
-- when it is issued (draft -> issued/applied posts its final total), and the
-- headline balance (clientBalanceService) never counted drafts. A draft that
-- still carries its create-time credit therefore makes the ledger's running
-- balance (Ledger tab, GET /clients/:id/balance-ledger, statement PDF) read
-- more in credit than the headline balance.
--
-- History is not deleted. For every credit note still in 'draft' (soft-deleted
-- drafts included, so a later restore + issue cannot double-post), append ONE
-- compensating 'debit' row equal to the net credit currently posted for it,
-- referencing the note exactly like the original (reference_type =
-- 'credit_note', reference_id = credit_notes.id, same client and org).
--
-- Idempotent: only notes whose NET posted credit is non-zero are touched, and
-- the reversal brings that net to zero, so a rerun inserts nothing. The signed
-- expression is ClientBalanceLedger.signedAmountSql (debit-type entry types
-- and the debit column count positive, everything else negative). Data-only:
-- no DDL, so no schema.sql change.
-- =============================================================================

INSERT INTO client_balance_ledger
  (client_id, organization_id, entry_type, amount, currency,
   reference_type, reference_id, description)
SELECT posted.client_id,
       posted.organization_id,
       'debit',
       -posted.net,
       COALESCE(posted.currency, cn.currency),
       'credit_note',
       cn.id,
       LEFT(CONCAT('Reversal: draft Credit Note ',
                   COALESCE(NULLIF(cn.credit_note_number, ''), cn.id),
                   ' (posts when issued)'), 255)
  FROM credit_notes cn
  JOIN (
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
 WHERE cn.status = 'draft'
   AND posted.net < -0.005;
