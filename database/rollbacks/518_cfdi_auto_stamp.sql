-- =============================================================================
-- Rollback 518 — opt-in CFDI stamping of generated invoices (BIL-33)
-- =============================================================================
-- Roll back the application code with this. Invoices are then stamped by
-- hand only. Safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_518_cfdi_auto_stamp;
DELIMITER //
CREATE PROCEDURE rollback_518_cfdi_auto_stamp()
BEGIN
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'organization_mx_profiles' AND COLUMN_NAME = 'cfdi_auto_stamp') THEN
    ALTER TABLE organization_mx_profiles DROP COLUMN cfdi_auto_stamp;
  END IF;
END //
DELIMITER ;

CALL rollback_518_cfdi_auto_stamp();
DROP PROCEDURE IF EXISTS rollback_518_cfdi_auto_stamp;
