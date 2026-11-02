-- =============================================================================
-- Rollback 502 — evidence rows cascade-delete with their client or
-- organization (DB-26)
-- =============================================================================
-- Restores ON DELETE CASCADE on the five evidence foreign keys (migrations
-- 447 and earlier). Roll back the application code with this.
-- Guarded on INFORMATION_SCHEMA; safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_502_cascade_fk;
DELIMITER //
CREATE PROCEDURE rollback_502_cascade_fk(
  IN p_table VARCHAR(64), IN p_constraint VARCHAR(64), IN p_column VARCHAR(64), IN p_parent VARCHAR(64)
)
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = p_table
       AND CONSTRAINT_NAME = p_constraint AND DELETE_RULE <> 'CASCADE'
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` DROP FOREIGN KEY `', p_constraint, '`');
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD CONSTRAINT `', p_constraint,
      '` FOREIGN KEY (`', p_column, '`) REFERENCES `', p_parent, '` (id) ON DELETE CASCADE ON UPDATE CASCADE');
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL rollback_502_cascade_fk('signed_documents', 'fk_signed_documents_client', 'client_id', 'clients');
CALL rollback_502_cascade_fk('subscriber_consents', 'fk_sub_consents_client', 'client_id', 'clients');
CALL rollback_502_cascade_fk('dsar_requests', 'fk_dsar_requests_client', 'client_id', 'clients');
CALL rollback_502_cascade_fk('audit_logs', 'fk_audit_logs_org', 'organization_id', 'organizations');
CALL rollback_502_cascade_fk('ift_statistical_reports', 'fk_ift_statistical_reports_organization', 'organization_id', 'organizations');
DROP PROCEDURE IF EXISTS rollback_502_cascade_fk;
