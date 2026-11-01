-- =============================================================================
-- Rollback 486 — restore installation-wide ip_assignments uniqueness
-- =============================================================================
-- Re-adding UNIQUE (ip_address, active_flag) fails if two pools now hold the
-- same live address, or an expired row shares an address with a live one.
-- Resolve those rows first: SELECT ip_address, COUNT(*) FROM ip_assignments
-- WHERE deleted_at IS NULL GROUP BY ip_address HAVING COUNT(*) > 1.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_486_ip_assignments_pool_scoped_unique;
DELIMITER //
CREATE PROCEDURE rollback_486_ip_assignments_pool_scoped_unique()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_assignments' AND INDEX_NAME = 'uq_ip_assignments_ip') THEN
    ALTER TABLE ip_assignments ADD UNIQUE KEY uq_ip_assignments_ip (ip_address, active_flag);
  END IF;
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_assignments' AND INDEX_NAME = 'idx_ip_assignments_ip') THEN
    ALTER TABLE ip_assignments DROP INDEX idx_ip_assignments_ip;
  END IF;
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_assignments' AND INDEX_NAME = 'uq_ip_assignments_pool_ip') THEN
    ALTER TABLE ip_assignments DROP INDEX uq_ip_assignments_pool_ip;
  END IF;
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_assignments' AND COLUMN_NAME = 'live_flag') THEN
    ALTER TABLE ip_assignments DROP COLUMN live_flag;
  END IF;
END //
DELIMITER ;

CALL rollback_486_ip_assignments_pool_scoped_unique();
DROP PROCEDURE IF EXISTS rollback_486_ip_assignments_pool_scoped_unique;
