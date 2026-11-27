-- Rollback 042 — drops the invoice number prefix setting. Invoices already
-- numbered keep their numbers; new ones are INV- again.

DROP PROCEDURE IF EXISTS r042_invoice_number_prefix;
DELIMITER $$
CREATE PROCEDURE r042_invoice_number_prefix()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'organization_invoice_settings' AND COLUMN_NAME = 'number_prefix'
  ) THEN
    ALTER TABLE organization_invoice_settings DROP COLUMN number_prefix;
  END IF;
END $$
DELIMITER ;
CALL r042_invoice_number_prefix();
DROP PROCEDURE IF EXISTS r042_invoice_number_prefix;
