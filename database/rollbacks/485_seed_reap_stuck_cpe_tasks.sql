-- =============================================================================
-- Rollback 485 — remove the stuck CPE task reaper
-- =============================================================================
-- Removes only the seeded install-wide task row. Tasks it already failed stay
-- failed.
-- =============================================================================

DELETE FROM scheduled_tasks
WHERE task_name = 'reap_stuck_cpe_tasks'
  AND organization_id IS NULL;
