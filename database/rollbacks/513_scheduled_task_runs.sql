-- =============================================================================
-- Rollback 513 — scheduled task run history (ASY-28)
-- =============================================================================
-- Roll back the application code with this. Safe to re-run.
-- =============================================================================

DROP TABLE IF EXISTS scheduled_task_runs;
