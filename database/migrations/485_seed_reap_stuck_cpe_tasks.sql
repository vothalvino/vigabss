-- =============================================================================
-- Migration 485 — Seed the stuck CPE task reaper (NET-19)
-- =============================================================================
-- A TR-069 task is set in_progress when the ACS dispatches its RPC. A CPE that
-- dropped the session, or whose response was never authenticated, left it
-- in_progress for ever: nothing failed it, and requests that wait on it (a
-- portal Wi-Fi password change) never settled. This task runs every 10 minutes
-- per organization and fails tasks still in_progress after 30 minutes.
--
-- Idempotency: INSERT ... SELECT ... WHERE NOT EXISTS, because the UNIQUE KEY
-- on (organization_id, task_name) never collides when organization_id is NULL.
-- =============================================================================

INSERT INTO scheduled_tasks
  (task_name, cron_expression, description, is_enabled, priority, organization_id)
SELECT 'reap_stuck_cpe_tasks', '*/10 * * * *',
       'Fail TR-069 CPE tasks dispatched and not answered within 30 minutes',
       TRUE, 'normal', NULL
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM scheduled_tasks
    WHERE task_name = 'reap_stuck_cpe_tasks' AND organization_id IS NULL
);
