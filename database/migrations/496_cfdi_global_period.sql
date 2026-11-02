-- =============================================================================
-- Migration 496 — a CFDI carries its own InformacionGlobal period (BIL-24)
-- =============================================================================
-- The InformacionGlobal node was always Periodicidad 01 with Meses/Año taken
-- from the CFDI date, so a monthly factura global (or one filed after the
-- month closed) reported the wrong period. These columns hold the period the
-- document reports; the expedition date stays only the fallback for a single
-- invoice stamped to público en general (a daily global for that day).
--
-- A factura global is issued to PUBLICO EN GENERAL, not to a client, so
-- client_id becomes nullable; every other CFDI still names its client.
-- Guarded on INFORMATION_SCHEMA; safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_496_cfdi_global_period;
DELIMITER //
CREATE PROCEDURE migration_496_cfdi_global_period()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND COLUMN_NAME = 'global_periodicidad'
  ) THEN
    ALTER TABLE cfdi_documents
      ADD COLUMN global_periodicidad VARCHAR(2) NULL
        COMMENT 'InformacionGlobal c_Periodicidad (01-05); NULL = not a global or derived from the date'
        AFTER receptor_cp,
      ADD COLUMN global_meses VARCHAR(2) NULL
        COMMENT 'InformacionGlobal c_Meses (01-12, or 13-18 for bimestral)'
        AFTER global_periodicidad,
      ADD COLUMN global_anio SMALLINT UNSIGNED NULL
        COMMENT 'InformacionGlobal Año'
        AFTER global_meses;
  END IF;

  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND COLUMN_NAME = 'client_id'
      AND IS_NULLABLE = 'NO'
  ) THEN
    ALTER TABLE cfdi_documents
      MODIFY COLUMN client_id BIGINT UNSIGNED NULL
        COMMENT 'Client (receptor) for this CFDI; NULL only for a factura global to PUBLICO EN GENERAL';
  END IF;
END //
DELIMITER ;

CALL migration_496_cfdi_global_period();
DROP PROCEDURE IF EXISTS migration_496_cfdi_global_period;
