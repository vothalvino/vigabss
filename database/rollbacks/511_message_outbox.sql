-- =============================================================================
-- Rollback 511 — one durable outbox for email, SMS, WhatsApp and push (ASY-33)
-- =============================================================================
-- Roll back the application code with this. Dropping the table discards any
-- message still queued in it. Safe to re-run.
-- =============================================================================

DELETE FROM scheduled_tasks WHERE task_name = 'message_outbox' AND organization_id IS NULL;

INSERT INTO scheduled_tasks
  (organization_id, task_name, task_type, description,
   cron_expression, priority, max_retries, timeout_seconds, is_enabled)
SELECT NULL, 'sms_send', 'notification',
       'Drain the SMS outbox: send queued sms_logs rows via the configured provider (Twilio or generic HTTP).',
       '* * * * *', 'high', 3, 60, TRUE
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_name = 'sms_send' AND organization_id IS NULL);

DELETE rp FROM role_permissions rp
JOIN permissions p ON p.id = rp.permission_id
WHERE p.name IN ('message_outbox.view', 'message_outbox.manage');
DELETE FROM permissions WHERE name IN ('message_outbox.view', 'message_outbox.manage');

DROP TABLE IF EXISTS message_outbox;
