-- =============================================================================
-- Migration 501 — organization-leading indexes for report and list queries;
-- drop the duplicate cfdi_documents.uuid unique index (DB-24)
-- =============================================================================
-- payments, tickets and work_orders had only single-column organization_id
-- keys, so the revenue and cash-flow reports (organization + date range) and
-- the ticket and work-order lists (organization + status, newest first) could
-- not use one index for both. cfdi_documents.uuid was unique twice: inline
-- (index `uuid`) and uq_cfdi_documents_uuid; the inline copy is dropped.
-- Guarded on INFORMATION_SCHEMA; safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_501_add_index;
DELIMITER //
CREATE PROCEDURE migration_501_add_index(IN p_table VARCHAR(64), IN p_index VARCHAR(64), IN p_columns VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND INDEX_NAME = p_index
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD KEY `', p_index, '` (', p_columns, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL migration_501_add_index('payments', 'idx_payments_org_payment_date', 'organization_id, payment_date');
CALL migration_501_add_index('payments', 'idx_payments_org_created', 'organization_id, created_at');
CALL migration_501_add_index('tickets', 'idx_tickets_org_status_created', 'organization_id, status, created_at');
CALL migration_501_add_index('work_orders', 'idx_wo_org_status_created', 'organization_id, status, created_at');
DROP PROCEDURE IF EXISTS migration_501_add_index;

DROP PROCEDURE IF EXISTS migration_501_drop_duplicate_uuid_index;
DELIMITER //
CREATE PROCEDURE migration_501_drop_duplicate_uuid_index()
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND INDEX_NAME = 'uq_cfdi_documents_uuid'
  ) AND EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND INDEX_NAME = 'uuid'
       AND COLUMN_NAME = 'uuid' AND NON_UNIQUE = 0
  ) THEN
    ALTER TABLE cfdi_documents DROP INDEX `uuid`;
  END IF;
END //
DELIMITER ;

CALL migration_501_drop_duplicate_uuid_index();
DROP PROCEDURE IF EXISTS migration_501_drop_duplicate_uuid_index;
