-- Rollback 012 — drops invoices.apply_client_credit. Invoices staff marked to
-- keep the client's credit off lose that mark (the earlier code never applies
-- credit automatically, so nothing changes for them). Allocations the credit
-- already made stay: they are ordinary payment allocations.

DROP PROCEDURE IF EXISTS r012_client_credit;
DELIMITER $$
CREATE PROCEDURE r012_client_credit()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'apply_client_credit'
  ) THEN
    ALTER TABLE invoices DROP COLUMN apply_client_credit;
  END IF;
END $$
DELIMITER ;
CALL r012_client_credit();
DROP PROCEDURE IF EXISTS r012_client_credit;
