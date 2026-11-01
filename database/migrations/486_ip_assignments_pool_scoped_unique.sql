-- =============================================================================
-- Migration 486 — ip_assignments uniqueness per pool, live rows only (NET-18)
-- =============================================================================
-- UNIQUE (ip_address, active_flag) spanned every tenant and pool and counted
-- 'expired' rows. Pool overlap is checked only within an organization, so two
-- shared-database organizations may both own 10.0.0.0/24: the second could not
-- record an address the first had, and the 409 told it the address existed
-- elsewhere. One 'expired' row made assign-next pick and fail on that address
-- for ever.
--
-- The key becomes UNIQUE (pool_id, ip_address, live_flag), where live_flag is
-- 1 only for a row that is neither soft-deleted nor expired. Uniqueness within
-- an organization stays enforced by the per-org overlap and availability
-- checks. The new key is looser than the old one, so existing rows cannot
-- violate it.
--
-- The guarded procedure makes the migration safe to resume after interrupted
-- MySQL DDL.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_486_ip_assignments_pool_scoped_unique;
DELIMITER //
CREATE PROCEDURE migration_486_ip_assignments_pool_scoped_unique()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_assignments' AND COLUMN_NAME = 'live_flag'
  ) THEN
    ALTER TABLE ip_assignments
      ADD COLUMN live_flag TINYINT(1)
        GENERATED ALWAYS AS (IF(deleted_at IS NULL AND status <> 'expired', 1, NULL)) STORED
        COMMENT 'NULL when soft-deleted or expired; keeps those rows out of uq_ip_assignments_pool_ip (migration 486)'
        AFTER active_flag;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_assignments' AND INDEX_NAME = 'uq_ip_assignments_pool_ip'
  ) THEN
    ALTER TABLE ip_assignments
      ADD UNIQUE KEY uq_ip_assignments_pool_ip (pool_id, ip_address, live_flag);
  END IF;

  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_assignments' AND INDEX_NAME = 'uq_ip_assignments_ip'
  ) THEN
    ALTER TABLE ip_assignments DROP INDEX uq_ip_assignments_ip;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_assignments' AND INDEX_NAME = 'idx_ip_assignments_ip'
  ) THEN
    ALTER TABLE ip_assignments ADD KEY idx_ip_assignments_ip (ip_address);
  END IF;
END //
DELIMITER ;

CALL migration_486_ip_assignments_pool_scoped_unique();
DROP PROCEDURE IF EXISTS migration_486_ip_assignments_pool_scoped_unique;
