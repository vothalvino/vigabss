-- =============================================================================
-- Migration 503 — seed the close_stale_sessions scheduled task (REG-10)
-- =============================================================================
-- A session whose Stop was lost stayed open forever, and an open session is
-- attributable only while it looks live. The task closes sessions silent for
-- longer than RADIUS_SESSION_LIVENESS_MINUTES at their last real accounting.
-- Requires the matching case in src/services/taskRunner.js.
-- A guarded SELECT is required because the nullable organization_id does not
-- make INSERT IGNORE idempotent for install-wide rows.
-- =============================================================================

INSERT INTO scheduled_tasks
    (organization_id, task_name, description, cron_expression, is_enabled, priority)
SELECT NULL,
       'close_stale_sessions',
       'Close RADIUS sessions with no accounting for longer than the liveness window at their last real accounting',
       '*/10 * * * *',
       TRUE,
       'normal'
  FROM DUAL
 WHERE NOT EXISTS (
   SELECT 1 FROM scheduled_tasks
    WHERE task_name = 'close_stale_sessions' AND organization_id IS NULL
 );
