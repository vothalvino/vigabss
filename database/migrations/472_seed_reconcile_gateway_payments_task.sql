-- =============================================================================
-- Migration 472 — Seed the gateway payment reconciliation retry task (BIL-05)
-- =============================================================================
-- A succeeded gateway transaction (Stripe/Conekta checkout, payment link,
-- autopay) now becomes a real payments row with allocations through
-- paymentGatewayService.reconcilePayment, linked by
-- payment_transactions.payment_id. When that posting fails the webhook answers
-- 500 so the provider redelivers, but a provider eventually gives up, and a
-- capture can also succeed without a webhook ever arriving. This install-wide
-- task sweeps every active organization (isolated tenants in their own
-- database) every 15 minutes and reconciles succeeded transactions that still
-- have no payment. Transactions settled by the pre-472 code (a
-- 'payment_transaction' ledger credit, no payment row) are left alone.
--
-- Idempotency: INSERT ... SELECT ... WHERE NOT EXISTS, because the UNIQUE KEY
-- on (organization_id, task_name) never collides when organization_id is NULL.
-- =============================================================================

INSERT INTO scheduled_tasks
  (task_name, cron_expression, description, is_enabled, priority, organization_id)
SELECT 'reconcile_gateway_payments', '*/15 * * * *',
       'Post succeeded gateway transactions that have no payment yet (retry of failed or missed reconciliation)',
       TRUE, 'high', NULL
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM scheduled_tasks
    WHERE task_name = 'reconcile_gateway_payments' AND organization_id IS NULL
);
