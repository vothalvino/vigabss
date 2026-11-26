-- Rollback 032 — drops the supervisor's review note on cashier sessions.
-- The reseller app sessions the migration retired stay retired: they held no
-- count, and the app no longer opens them.

DROP PROCEDURE IF EXISTS r032_cashier_review;
DELIMITER $$
CREATE PROCEDURE r032_cashier_review()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cash_reconciliation_sessions' AND COLUMN_NAME = 'review_note'
  ) THEN
    ALTER TABLE cash_reconciliation_sessions DROP COLUMN review_note;
  END IF;
END $$
DELIMITER ;
CALL r032_cashier_review();
DROP PROCEDURE IF EXISTS r032_cashier_review;

ALTER TABLE cash_reconciliation_sessions
  MODIFY COLUMN approved_by BIGINT UNSIGNED NULL
    COMMENT 'Supervisor who approved or disputed the session';
