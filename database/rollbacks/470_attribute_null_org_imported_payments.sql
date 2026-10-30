-- =============================================================================
-- Rollback 470 — intentionally preserve the payment organization attribution
-- =============================================================================
-- Migration 470 changes no schema. It set organization_id on live payments
-- that had none, copying their client's organization. The affected ids were
-- not recorded separately, so a rollback could not tell them from payments
-- created with an organization; clearing it again would hide those payments
-- from every org-scoped list, balance and portal view. Not reverted.

SELECT 1 AS null_org_payment_attribution_preserved;
