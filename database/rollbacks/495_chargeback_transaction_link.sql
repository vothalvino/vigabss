-- =============================================================================
-- Rollback 495 — back to an install-wide unique dispute id; drop the link
-- =============================================================================
-- Fails if two organizations or gateways now hold the same dispute id; the
-- application must be rolled back with this.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_495_chargeback_transaction_link;
DELIMITER //
CREATE PROCEDURE rollback_495_chargeback_transaction_link()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chargebacks' AND INDEX_NAME = 'uq_chargebacks_gateway_dispute_id') THEN
    ALTER TABLE chargebacks ADD UNIQUE KEY uq_chargebacks_gateway_dispute_id (gateway_dispute_id);
  END IF;
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chargebacks' AND INDEX_NAME = 'uq_chargebacks_org_gateway_dispute') THEN
    ALTER TABLE chargebacks DROP INDEX uq_chargebacks_org_gateway_dispute;
  END IF;
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chargebacks' AND COLUMN_NAME = 'payment_transaction_id') THEN
    ALTER TABLE chargebacks DROP KEY idx_chargebacks_payment_transaction_id, DROP COLUMN payment_transaction_id;
  END IF;
END //
DELIMITER ;

CALL rollback_495_chargeback_transaction_link();
DROP PROCEDURE IF EXISTS rollback_495_chargeback_transaction_link;
