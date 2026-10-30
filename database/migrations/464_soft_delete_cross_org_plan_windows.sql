-- =============================================================================
-- Migration 464 — soft-delete plan speed/access windows owned by another org
-- =============================================================================
-- Before the Phase 0 tenant-isolation fix (TNB-04), POST
-- /plans/:id/speed-windows and /plans/:id/access-windows inserted
-- organization_id = <caller's org> without verifying that the plan in the URL
-- belonged to the caller.  The RADIUS Access-Accept path and the global
-- apply_speed_windows sweep key on plan_id, so such a row could throttle or
-- time-block another tenant's subscribers.
--
-- The routes now 404 a foreign plan.  This repair retires any row that was
-- already written with a mismatched owner: a window whose organization_id is
-- not (null-safe) equal to its plan's organization_id.  Rows already
-- soft-deleted are left untouched, so the original deleted_at is preserved and
-- the statement is rerun-safe.  Data-only: no DDL, so no schema.sql change.
-- =============================================================================

UPDATE plan_speed_windows w
JOIN plans p ON p.id = w.plan_id
   SET w.deleted_at = NOW()
 WHERE w.deleted_at IS NULL
   AND NOT (w.organization_id <=> p.organization_id);

UPDATE plan_access_windows w
JOIN plans p ON p.id = w.plan_id
   SET w.deleted_at = NOW()
 WHERE w.deleted_at IS NULL
   AND NOT (w.organization_id <=> p.organization_id);
