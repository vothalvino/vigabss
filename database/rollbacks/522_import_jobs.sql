-- =============================================================================
-- Rollback 522 — CSV imports run as background jobs
-- =============================================================================
-- Drops the job table. Imports go back to running inside the web request only
-- with the application code that did so.
-- =============================================================================

DROP TABLE IF EXISTS import_jobs;
