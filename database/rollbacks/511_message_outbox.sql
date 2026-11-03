-- =============================================================================
-- Rollback 511 — one durable outbox for email, SMS, WhatsApp and push (ASY-33)
-- =============================================================================
-- Roll back the application code with this. Dropping the table discards any
-- message still queued in it. Safe to re-run.
-- =============================================================================

DELETE FROM scheduled_tasks WHERE task_name = 'message_outbox' AND organization_id IS NULL;

DELETE rp FROM role_permissions rp
JOIN permissions p ON p.id = rp.permission_id
WHERE p.name IN ('message_outbox.view', 'message_outbox.manage');
DELETE FROM permissions WHERE name IN ('message_outbox.view', 'message_outbox.manage');

DROP TABLE IF EXISTS message_outbox;
