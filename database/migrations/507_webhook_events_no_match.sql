-- =============================================================================
-- Migration 507 — webhook_events.status 'no_match' (BIL-32)
-- =============================================================================
-- A payment webhook that matched no transaction was stored as 'failed', so a
-- provider sending events for payments VigaBSS never created looked the same
-- as a processing error. 'no_match' is reprocessed on redelivery like
-- 'failed', because the transaction may exist by then.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_507_webhook_no_match;
DELIMITER //
CREATE PROCEDURE migration_507_webhook_no_match()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhook_events'
       AND COLUMN_NAME = 'status' AND COLUMN_TYPE LIKE '%''no_match''%'
  ) THEN
    ALTER TABLE webhook_events
      MODIFY COLUMN status ENUM('received', 'processing', 'processed', 'failed', 'ignored', 'no_match')
        NOT NULL DEFAULT 'received' COMMENT 'Processing status';
  END IF;
END //
DELIMITER ;

CALL migration_507_webhook_no_match();
DROP PROCEDURE IF EXISTS migration_507_webhook_no_match;
