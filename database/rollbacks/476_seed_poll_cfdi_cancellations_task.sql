-- Rollback: 476_seed_poll_cfdi_cancellations_task
-- Removes only the seeded install-wide task row. Cancellations it already
-- resolved reflect SAT's answer and are deliberately not touched.
DELETE FROM scheduled_tasks
WHERE task_name = 'poll_cfdi_cancellations'
  AND organization_id IS NULL;
