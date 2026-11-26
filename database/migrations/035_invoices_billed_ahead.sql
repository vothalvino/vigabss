-- =============================================================================
-- Migration 035 — an invoice can be billed ahead
-- =============================================================================
-- Money a client pays beyond what it owes is invoiced when it arrives: the
-- client's coming months are invoiced then, and paid by that money
-- (services/billAheadService.js). Such an invoice is marked:
--
--   invoices.billed_ahead   1 = invoiced before its billing period was due
--
-- Safe to re-run: the column is added only when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m035_invoices_billed_ahead;
DELIMITER $$
CREATE PROCEDURE m035_invoices_billed_ahead()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'billed_ahead'
  ) THEN
    ALTER TABLE invoices
      ADD COLUMN billed_ahead TINYINT(1) NOT NULL DEFAULT 0
        COMMENT '1 = invoiced before its billing period was due, because the client paid ahead (migration 035)'
        AFTER apply_client_credit;
  END IF;
END $$
DELIMITER ;
CALL m035_invoices_billed_ahead();
DROP PROCEDURE IF EXISTS m035_invoices_billed_ahead;
