-- =============================================================================
-- Migration 040 — a General Public invoice is built from chosen payments
-- =============================================================================
-- A General Public invoice (factura global) states one form of payment, so it
-- is made per form of payment (cash, card, transfer, check) from the payments
-- of a date range, not once per month from everything:
--
--   factura_publica_invoices.forma_pago   the SAT form of payment it reports
--   factura_publica_invoices.date_from    first payment day it covers
--   factura_publica_invoices.date_to      last payment day it covers
--
-- An organization can therefore hold several records for the same period, so
-- the unique key on (organization, periodicidad, meses, anio) becomes a plain
-- index. An invoice can still be in only one of them
-- (uq_factura_publica_invoice_items_invoice).
--
-- Safe to re-run: each change is made only when still needed.
-- =============================================================================

DROP PROCEDURE IF EXISTS m040_factura_global_by_payment;
DELIMITER $$
CREATE PROCEDURE m040_factura_global_by_payment()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factura_publica_invoices' AND COLUMN_NAME = 'forma_pago'
  ) THEN
    ALTER TABLE factura_publica_invoices
      ADD COLUMN forma_pago VARCHAR(2) NULL
        COMMENT 'SAT c_FormaPago this record reports (01 cash, 02 check, 03 transfer, 04 credit card, 28 debit card); NULL on records made before migration 040, which report the predominant one'
        AFTER anio,
      ADD COLUMN date_from DATE NULL COMMENT 'First payment day the record covers (migration 040)' AFTER forma_pago,
      ADD COLUMN date_to DATE NULL COMMENT 'Last payment day the record covers (migration 040)' AFTER date_from;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factura_publica_invoices' AND INDEX_NAME = 'idx_factura_publica_invoices_period'
  ) THEN
    ALTER TABLE factura_publica_invoices
      ADD KEY idx_factura_publica_invoices_period (organization_id, periodicidad, meses, anio);
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'factura_publica_invoices' AND INDEX_NAME = 'uq_factura_publica_invoices_period'
  ) THEN
    ALTER TABLE factura_publica_invoices DROP INDEX uq_factura_publica_invoices_period;
  END IF;
END $$
DELIMITER ;
CALL m040_factura_global_by_payment();
DROP PROCEDURE IF EXISTS m040_factura_global_by_payment;
