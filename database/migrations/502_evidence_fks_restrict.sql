-- =============================================================================
-- Migration 502 — evidence rows no longer cascade-delete with their client or
-- organization (DB-26)
-- =============================================================================
-- signed_documents, subscriber_consents and dsar_requests cascaded from
-- clients, and audit_logs and ift_statistical_reports from organizations.
-- MySQL fires no triggers for cascaded rows, so an organization delete also
-- bypassed audit_logs' immutability triggers. Each foreign key becomes
-- ON DELETE RESTRICT: a client or organization that has evidence must be
-- anonymized (clients are soft-deleted; DSAR erasure anonymizes), not deleted.
-- Guarded on INFORMATION_SCHEMA; safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_502_restrict_fk;
DELIMITER //
CREATE PROCEDURE migration_502_restrict_fk(
  IN p_table VARCHAR(64), IN p_constraint VARCHAR(64), IN p_column VARCHAR(64), IN p_parent VARCHAR(64)
)
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = p_table
       AND CONSTRAINT_NAME = p_constraint AND DELETE_RULE <> 'RESTRICT'
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` DROP FOREIGN KEY `', p_constraint, '`');
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD CONSTRAINT `', p_constraint,
      '` FOREIGN KEY (`', p_column, '`) REFERENCES `', p_parent, '` (id) ON DELETE RESTRICT ON UPDATE CASCADE');
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL migration_502_restrict_fk('signed_documents', 'fk_signed_documents_client', 'client_id', 'clients');
CALL migration_502_restrict_fk('subscriber_consents', 'fk_sub_consents_client', 'client_id', 'clients');
CALL migration_502_restrict_fk('dsar_requests', 'fk_dsar_requests_client', 'client_id', 'clients');
CALL migration_502_restrict_fk('audit_logs', 'fk_audit_logs_org', 'organization_id', 'organizations');
CALL migration_502_restrict_fk('ift_statistical_reports', 'fk_ift_statistical_reports_organization', 'organization_id', 'organizations');
DROP PROCEDURE IF EXISTS migration_502_restrict_fk;
