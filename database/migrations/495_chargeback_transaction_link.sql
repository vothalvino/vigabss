-- =============================================================================
-- Migration 495 — chargebacks link their gateway transaction; dispute ids are
--                 unique per organization and gateway (WHK-14)
-- =============================================================================
-- A webhook-created chargeback kept only payment_id (a payments row, NULL when
-- the disputed charge was never reconciled), so the transaction the dispute
-- was matched to was lost. payment_transaction_id records it.
--
-- gateway_dispute_id was UNIQUE across the whole install, so two tenants (or
-- two gateways) reporting the same provider id collided and the second one
-- was folded into the first by ON DUPLICATE KEY. The key becomes
-- (organization_id, gateway, gateway_dispute_id). The new key is added before
-- the old one is dropped, so uniqueness never lapses. Guarded on
-- INFORMATION_SCHEMA; safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_495_chargeback_transaction_link;
DELIMITER //
CREATE PROCEDURE migration_495_chargeback_transaction_link()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chargebacks' AND COLUMN_NAME = 'payment_transaction_id'
  ) THEN
    ALTER TABLE chargebacks
      ADD COLUMN payment_transaction_id BIGINT UNSIGNED NULL
        COMMENT 'payment_transactions row the dispute was matched to (webhook-created chargebacks)'
        AFTER payment_id,
      ADD KEY idx_chargebacks_payment_transaction_id (payment_transaction_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chargebacks' AND INDEX_NAME = 'uq_chargebacks_org_gateway_dispute'
  ) THEN
    ALTER TABLE chargebacks
      ADD UNIQUE KEY uq_chargebacks_org_gateway_dispute (organization_id, gateway, gateway_dispute_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chargebacks' AND INDEX_NAME = 'uq_chargebacks_gateway_dispute_id'
  ) THEN
    ALTER TABLE chargebacks DROP INDEX uq_chargebacks_gateway_dispute_id;
  END IF;
END //
DELIMITER ;

CALL migration_495_chargeback_transaction_link();
DROP PROCEDURE IF EXISTS migration_495_chargeback_transaction_link;
