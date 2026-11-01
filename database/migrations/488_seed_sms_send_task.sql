-- =============================================================================
-- Migration 488 — Seed the SMS outbox sweeper (ASY-20)
-- =============================================================================
-- sms_send was seeded only in schema.sql, and installs are built by migrate.js,
-- so a migrated install never ran it. queueSms only enqueues a BullMQ job when
-- REDIS_URL is set; this task is the only drain of status='queued' rows without
-- Redis, and the only recovery of failed enqueues and stale delivery claims
-- with it. Same row as schema.sql.
--
-- Idempotency: INSERT ... SELECT ... WHERE NOT EXISTS, because the UNIQUE KEY
-- on (organization_id, task_name) never collides when organization_id is NULL.
-- =============================================================================

INSERT INTO scheduled_tasks
  (organization_id, task_name, task_type, description,
   cron_expression, priority, max_retries, timeout_seconds, is_enabled)
SELECT NULL, 'sms_send', 'notification',
       'Drain the SMS outbox: send queued sms_logs rows via the configured provider (Twilio or generic HTTP).',
       '* * * * *', 'high', 3, 60, TRUE
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM scheduled_tasks
    WHERE task_name = 'sms_send' AND organization_id IS NULL
);
