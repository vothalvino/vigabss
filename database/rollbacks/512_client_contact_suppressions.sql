-- =============================================================================
-- Rollback 512 — undeliverable client addresses from provider reports (ASY-33)
-- =============================================================================
-- Roll back the application code with this. Safe to re-run.
-- =============================================================================

DROP TABLE IF EXISTS client_contact_suppressions;
