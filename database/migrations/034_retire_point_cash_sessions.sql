-- =============================================================================
-- Migration 034 — no cash session of a reseller or collector stays on the page
-- =============================================================================
-- Migration 032 retired the sessions the reseller app had opened behind the
-- scenes and never closed. The app also had a way to close one, so some of
-- those sessions are closed instead of open. They hold a count nobody on the
-- staff side asked for, and on the staff Cashier page they wait for a review
-- for ever. They are retired too (soft-deleted); the ledger entries that name
-- them keep their reference.
--
-- Safe to re-run: retiring an already retired session changes nothing.
-- =============================================================================

UPDATE cash_reconciliation_sessions
   SET deleted_at = NOW()
 WHERE deleted_at IS NULL
   AND notes = 'Opened by the reseller app';
