-- Rollback: 472_seed_reconcile_gateway_payments_task
-- Removes only the seeded install-wide task row. Payments already posted by the
-- sweep are real bookkeeping and are deliberately not touched.
DELETE FROM scheduled_tasks
WHERE task_name = 'reconcile_gateway_payments'
  AND organization_id IS NULL;
