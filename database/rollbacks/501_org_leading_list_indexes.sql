-- =============================================================================
-- Rollback 501 — drop the organization-leading list indexes and restore the
-- inline cfdi_documents.uuid unique index
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_501_drop_index;
DELIMITER //
CREATE PROCEDURE rollback_501_drop_index(IN p_table VARCHAR(64), IN p_index VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND INDEX_NAME = p_index
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` DROP INDEX `', p_index, '`');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL rollback_501_drop_index('payments', 'idx_payments_org_payment_date');
CALL rollback_501_drop_index('payments', 'idx_payments_org_created');
CALL rollback_501_drop_index('tickets', 'idx_tickets_org_status_created');
CALL rollback_501_drop_index('work_orders', 'idx_wo_org_status_created');
DROP PROCEDURE IF EXISTS rollback_501_drop_index;

DROP PROCEDURE IF EXISTS rollback_501_restore_uuid_index;
DELIMITER //
CREATE PROCEDURE rollback_501_restore_uuid_index()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND INDEX_NAME = 'uuid'
  ) THEN
    ALTER TABLE cfdi_documents ADD UNIQUE KEY `uuid` (uuid);
  END IF;
END //
DELIMITER ;

CALL rollback_501_restore_uuid_index();
DROP PROCEDURE IF EXISTS rollback_501_restore_uuid_index;
