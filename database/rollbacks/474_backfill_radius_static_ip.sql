-- =============================================================================
-- Rollback 474 — intentionally keep the copied RADIUS static IPs
-- =============================================================================
-- Migration 474 changes no schema. It copied each PPPoE contract's static IPv4
-- address onto its RADIUS account where the account had none. The copied ids
-- were not recorded, so a rollback could not tell them from addresses set on
-- the account directly, and clearing them would take the subscribers' fixed
-- addresses away again. Not reverted.

SELECT 1 AS radius_static_ip_backfill_preserved;
