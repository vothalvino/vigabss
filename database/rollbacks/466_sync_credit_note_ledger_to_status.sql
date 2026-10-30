-- =============================================================================
-- Rollback 466 — intentionally preserve the credit-note ledger sync rows
-- =============================================================================
-- Migration 466 changes no schema. It appended one compensating
-- client_balance_ledger row per credit note whose net posted credit differed
-- from its status (top-up credits for issued/applied notes, reversal debits for
-- cancelled or soft-deleted ones). They are NOT removed: ledger history is
-- never deleted, and the synced ledger is the correct picture of those notes
-- (the headline balance counts exactly the issued/applied ones).
--
-- Known consequence of rolling the APPLICATION back as well: the previous
-- version wrote no reversal on cancel or soft-delete and no credit for
-- refund-path notes, so ledger drift resumes for notes changed under it.
-- Re-deploying this release does not resync those notes; rerun migration 466's
-- statement by hand (it is idempotent) to do so.

SELECT 1 AS credit_note_ledger_sync_preserved;
