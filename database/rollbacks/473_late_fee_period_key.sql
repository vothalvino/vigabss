-- =============================================================================
-- Rollback 473 — drop the late-fee period key
-- =============================================================================
-- Removes the per-month uniqueness. Late fees are then bounded only by
-- lateFeeService's own checks again.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_473_late_fee_period_key;
DELIMITER //
CREATE PROCEDURE rollback_473_late_fee_period_key()
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'invoice_late_fees'
       AND INDEX_NAME = 'uq_invoice_late_fees_period'
  ) THEN
    ALTER TABLE invoice_late_fees DROP INDEX uq_invoice_late_fees_period;
  END IF;
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'invoice_late_fees'
       AND COLUMN_NAME = 'period_key'
  ) THEN
    ALTER TABLE invoice_late_fees DROP COLUMN period_key;
  END IF;
END //
DELIMITER ;

CALL rollback_473_late_fee_period_key();
DROP PROCEDURE IF EXISTS rollback_473_late_fee_period_key;
