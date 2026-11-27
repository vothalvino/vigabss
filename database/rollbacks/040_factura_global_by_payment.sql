-- Rollback 040 — drops the form of payment and the date range of a General
-- Public invoice. The records stay; the one-per-period unique key is not put
-- back, because several records of one period may exist by now.

DROP PROCEDURE IF EXISTS r040_factura_global_by_payment;
DELIMITER $$
CREATE PROCEDURE r040_factura_global_by_payment()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factura_publica_invoices' AND COLUMN_NAME = 'forma_pago'
  ) THEN
    ALTER TABLE factura_publica_invoices DROP COLUMN forma_pago, DROP COLUMN date_from, DROP COLUMN date_to;
  END IF;
END $$
DELIMITER ;
CALL r040_factura_global_by_payment();
DROP PROCEDURE IF EXISTS r040_factura_global_by_payment;
