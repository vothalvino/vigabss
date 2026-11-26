-- Rollback 033 — drops cash pickups and the opening count of cashier sessions.
-- A session's expected_total keeps the value it was closed with.

DROP TABLE IF EXISTS cash_reconciliation_pickups;

DROP PROCEDURE IF EXISTS r033_cashier_pickups;
DELIMITER $$
CREATE PROCEDURE r033_cashier_pickups()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cash_reconciliation_sessions' AND COLUMN_NAME = 'pickups_total'
  ) THEN
    ALTER TABLE cash_reconciliation_sessions DROP COLUMN pickups_total;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cash_reconciliation_sessions' AND COLUMN_NAME = 'opening_expected'
  ) THEN
    ALTER TABLE cash_reconciliation_sessions DROP COLUMN opening_expected;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cash_reconciliation_sessions' AND COLUMN_NAME = 'opening_total'
  ) THEN
    ALTER TABLE cash_reconciliation_sessions DROP COLUMN opening_total;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cash_reconciliation_sessions' AND COLUMN_NAME = 'expected_total'
       AND COLUMN_COMMENT LIKE '%migration 033%'
  ) THEN
    ALTER TABLE cash_reconciliation_sessions
      MODIFY COLUMN expected_total DECIMAL(12,2) NULL
        COMMENT 'System-computed total of cash payments recorded during session window';
  END IF;
END $$
DELIMITER ;
CALL r033_cashier_pickups();
DROP PROCEDURE IF EXISTS r033_cashier_pickups;
