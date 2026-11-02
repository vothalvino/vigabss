-- =============================================================================
-- Rollback 503 — remove the close_stale_sessions scheduled task (REG-10)
-- =============================================================================
-- Roll back the application code with this. Safe to re-run.
-- =============================================================================

DELETE FROM scheduled_tasks
 WHERE task_name = 'close_stale_sessions' AND organization_id IS NULL;
