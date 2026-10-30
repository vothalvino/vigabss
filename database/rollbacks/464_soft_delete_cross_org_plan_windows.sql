-- =============================================================================
-- Rollback 464 — intentionally preserve the cross-org window repair
-- =============================================================================
-- Migration 464 changes no schema.  It soft-deleted plan_speed_windows and
-- plan_access_windows rows whose organization_id did not match their plan's.
-- Those soft-deletes are NOT auto-restored: the affected ids were not recorded
-- separately, so a rollback could not distinguish them from rows deleted
-- through the API at the same time, and reviving a window attached to another
-- tenant's plan would re-open the cross-tenant throttling/time-block hole.
-- An operator who must restore a specific row can clear its deleted_at
-- manually after confirming ownership.

SELECT 1 AS cross_org_plan_window_repair_preserved;
