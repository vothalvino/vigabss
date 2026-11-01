-- =============================================================================
-- Rollback 496 — drop the explicit InformacionGlobal period columns
-- =============================================================================
-- Globals fall back to the date-derived daily period; roll back the
-- application code with this.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_496_cfdi_global_period;
DELIMITER //
CREATE PROCEDURE rollback_496_cfdi_global_period()
BEGIN
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND COLUMN_NAME = 'global_periodicidad') THEN
    ALTER TABLE cfdi_documents DROP COLUMN global_periodicidad, DROP COLUMN global_meses, DROP COLUMN global_anio;
  END IF;
  -- Fails while a factura global (client_id NULL) exists; delete or re-home it first.
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND COLUMN_NAME = 'client_id'
                AND IS_NULLABLE = 'YES') THEN
    ALTER TABLE cfdi_documents
      MODIFY COLUMN client_id BIGINT UNSIGNED NOT NULL COMMENT 'Client (receptor) for this CFDI';
  END IF;
END //
DELIMITER ;

CALL rollback_496_cfdi_global_period();
DROP PROCEDURE IF EXISTS rollback_496_cfdi_global_period;
