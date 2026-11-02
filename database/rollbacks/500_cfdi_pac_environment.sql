-- =============================================================================
-- Rollback 500 — drop cfdi_documents.pac_environment
-- =============================================================================
-- Sandbox CFDIs are then distinguishable only by their PAC provider name;
-- roll back the application code with this.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_500_cfdi_pac_environment;
DELIMITER //
CREATE PROCEDURE rollback_500_cfdi_pac_environment()
BEGIN
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND COLUMN_NAME = 'pac_environment') THEN
    ALTER TABLE cfdi_documents DROP COLUMN pac_environment;
  END IF;
END //
DELIMITER ;

CALL rollback_500_cfdi_pac_environment();
DROP PROCEDURE IF EXISTS rollback_500_cfdi_pac_environment;
