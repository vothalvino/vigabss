-- =============================================================================
-- Rollback 521 — Freeze a cash session's payments when it closes
-- =============================================================================
-- Drops the snapshot. A closed session's detail reads the time window again.
-- =============================================================================

DROP TABLE IF EXISTS cash_reconciliation_session_payments;
