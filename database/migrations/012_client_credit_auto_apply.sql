-- =============================================================================
-- Migration 012 — client credit pays the next invoices on its own
-- =============================================================================
-- A completed payment that is not fully allocated is credit on the client
-- (a payment made ahead at a reseller, a collector, the portal or the
-- office). services/clientCreditService.js now applies it to the client's
-- payable invoices when an invoice is created and in a daily sweep. Staff
-- creating an invoice by hand may untick "Use the customer's credit": that
-- choice is kept on the invoice so the sweep leaves it alone.
--
-- invoices.apply_client_credit: 1 (default) = the client's credit may pay
-- this invoice automatically; 0 = only by hand.
--
-- Safe to re-run: the DDL step is guarded.
-- =============================================================================

DROP PROCEDURE IF EXISTS m012_client_credit;
DELIMITER $$
CREATE PROCEDURE m012_client_credit()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'apply_client_credit'
  ) THEN
    ALTER TABLE invoices ADD COLUMN apply_client_credit TINYINT(1) NOT NULL DEFAULT 1
      COMMENT '1 = the client''s credit may pay this invoice automatically; 0 = only by hand (migration 012)' AFTER paid_at;
  END IF;
END $$
DELIMITER ;
CALL m012_client_credit();
DROP PROCEDURE IF EXISTS m012_client_credit;
