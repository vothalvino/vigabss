-- =============================================================================
-- Migration 042 — an organization chooses the prefix of its invoice numbers
-- =============================================================================
-- Every invoice was numbered INV-000123, for every organization. In Mexico the
-- document is a remisión (the fiscal invoice is the CFDI), so the number
-- should read REM-000123, and an operator may want its own letters:
--
--   organization_invoice_settings.number_prefix   the letters before the
--       number; NULL = the default for the organization (REM in Mexico, INV
--       elsewhere)
--
-- Only invoices created from now on take the prefix. The counter is the same
-- one, so the numbers keep running. Safe to re-run: the column is added only
-- when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m042_invoice_number_prefix;
DELIMITER $$
CREATE PROCEDURE m042_invoice_number_prefix()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'organization_invoice_settings' AND COLUMN_NAME = 'number_prefix'
  ) THEN
    ALTER TABLE organization_invoice_settings
      ADD COLUMN number_prefix VARCHAR(10) NULL
        COMMENT 'Letters before the invoice number (REM gives REM-000123); NULL = the default: REM for a Mexican organization, INV otherwise (migration 042)'
        AFTER payment_instructions;
  END IF;
END $$
DELIMITER ;
CALL m042_invoice_number_prefix();
DROP PROCEDURE IF EXISTS m042_invoice_number_prefix;
