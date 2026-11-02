-- =============================================================================
-- Migration 500 — a stamped CFDI records the PAC environment it was stamped in
-- (BIL-35)
-- =============================================================================
-- cfdi_documents named only the PAC provider, so a sandbox or simulator CFDI
-- looked like a real one once the organization switched to production. The
-- environment of the PAC row that stamped it is saved here at stamp time; the
-- list, the invoice page and the PDF badge sandbox documents as not fiscally
-- valid. NULL = not stamped yet. Guarded on INFORMATION_SCHEMA; safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_500_cfdi_pac_environment;
DELIMITER //
CREATE PROCEDURE migration_500_cfdi_pac_environment()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND COLUMN_NAME = 'pac_environment'
  ) THEN
    ALTER TABLE cfdi_documents
      ADD COLUMN pac_environment ENUM('sandbox', 'production') NULL
        COMMENT 'Environment of the PAC row that stamped this CFDI; sandbox = not fiscally valid (migration 500)'
        AFTER pac_provider;
  END IF;
END //
DELIMITER ;

CALL migration_500_cfdi_pac_environment();
DROP PROCEDURE IF EXISTS migration_500_cfdi_pac_environment;
