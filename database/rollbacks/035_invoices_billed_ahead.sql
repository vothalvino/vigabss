-- Rollback 035 — drops the "billed ahead" mark. The invoices stay as they are.

DROP PROCEDURE IF EXISTS r035_invoices_billed_ahead;
DELIMITER $$
CREATE PROCEDURE r035_invoices_billed_ahead()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'billed_ahead'
  ) THEN
    ALTER TABLE invoices DROP COLUMN billed_ahead;
  END IF;
END $$
DELIMITER ;
CALL r035_invoices_billed_ahead();
DROP PROCEDURE IF EXISTS r035_invoices_billed_ahead;
