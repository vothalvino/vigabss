-- =============================================================================
-- Migration 476 — Seed the CFDI cancellation status poll (CFD-01)
-- =============================================================================
-- SAT's EstatusUUID 201/202 only says a cancellation request was registered.
-- A CFDI that needs the receptor's acceptance stays 'En proceso' for up to 72
-- hours; the receptor may refuse it, or it is cancelled by default when the
-- term expires ('Plazo vencido'). Cancellations are now booked as cancelado
-- only when SAT says so, so the rest wait in cancel_pending. This
-- install-wide task runs every hour for every active organization and asks
-- the PAC/SAT for the current status of each one still pending.
--
-- Idempotency: INSERT ... SELECT ... WHERE NOT EXISTS, because the UNIQUE KEY
-- on (organization_id, task_name) never collides when organization_id is NULL.
-- =============================================================================

INSERT INTO scheduled_tasks
  (task_name, cron_expression, description, is_enabled, priority, organization_id)
SELECT 'poll_cfdi_cancellations', '17 * * * *',
       'Ask SAT for the status of CFDI cancellations still waiting for the receptor (cancel_pending)',
       TRUE, 'normal', NULL
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM scheduled_tasks
    WHERE task_name = 'poll_cfdi_cancellations' AND organization_id IS NULL
);
