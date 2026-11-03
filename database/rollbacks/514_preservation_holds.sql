-- =============================================================================
-- Rollback 514 — case-scoped preservation holds (REG-06)
-- =============================================================================
-- Roll back the application code with this. Safe to re-run. Active holds are
-- lost: export them first if a case still needs them.
-- =============================================================================

DROP TABLE IF EXISTS preservation_holds;
