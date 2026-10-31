-- =============================================================================
-- Rollback 475 — drop the soft-suspension throttle columns
-- =============================================================================
-- Contracts soft-suspended at rollback time lose their throttle: the next
-- RADIUS sync or re-authentication gives them their plan speed again.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_475_contract_soft_suspend_throttle;
DELIMITER //
CREATE PROCEDURE rollback_475_contract_soft_suspend_throttle()
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'contracts'
       AND COLUMN_NAME = 'soft_suspend_upload_kbps'
  ) THEN
    ALTER TABLE contracts DROP COLUMN soft_suspend_upload_kbps;
  END IF;
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'contracts'
       AND COLUMN_NAME = 'soft_suspend_download_kbps'
  ) THEN
    ALTER TABLE contracts DROP COLUMN soft_suspend_download_kbps;
  END IF;
END //
DELIMITER ;

CALL rollback_475_contract_soft_suspend_throttle();
DROP PROCEDURE IF EXISTS rollback_475_contract_soft_suspend_throttle;
