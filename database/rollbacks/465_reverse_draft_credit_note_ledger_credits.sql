-- =============================================================================
-- Rollback 465 — intentionally preserve the draft credit-note reversals
-- =============================================================================
-- Migration 465 changes no schema. It appended compensating 'debit' rows for
-- draft credit notes that still carried a create-time ledger credit. They are
-- NOT removed: ledger history is never deleted, and the reversed ledger is the
-- correct picture of a draft (the headline balance never counted drafts).
--
-- Known consequence of rolling the APPLICATION back as well: the previous
-- version only posted a credit note at creation, never on PUT, so a reversed
-- draft issued under that version gets no ledger credit (the headline balance
-- still counts it). Re-deploying this release does not backfill that; post a
-- manual adjustment for any such note.

SELECT 1 AS draft_credit_note_ledger_reversal_preserved;
