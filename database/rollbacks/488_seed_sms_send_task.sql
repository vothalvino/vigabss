-- =============================================================================
-- Rollback 488 — remove the SMS outbox sweeper seed
-- =============================================================================
-- Removes only the install-wide task row. Queued SMS stay queued until the
-- task is re-created.
-- =============================================================================

DELETE FROM scheduled_tasks
WHERE task_name = 'sms_send'
  AND organization_id IS NULL;
