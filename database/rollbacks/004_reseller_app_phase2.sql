-- Rollback 004 — removes the reseller app, phase 2 (cash collection).
-- The reseller ledger is the record of cash a reseller collected for the ISP
-- and handed in, and payments.reseller_id says which reseller took each
-- payment. Neither can be restored once dropped, so the rollback refuses
-- while either holds data. The payments themselves stay: they are ordinary
-- completed cash payments of their clients. Roll back only to recover from a
-- failed deploy, then roll forward.

DROP PROCEDURE IF EXISTS r004_refuse_with_ledger;
DELIMITER $$
CREATE PROCEDURE r004_refuse_with_ledger()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries'
  ) THEN
    IF EXISTS (SELECT 1 FROM reseller_ledger_entries LIMIT 1) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Rollback 004 refused: reseller_ledger_entries holds reseller cash records';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'reseller_id'
  ) THEN
    IF EXISTS (SELECT 1 FROM payments WHERE reseller_id IS NOT NULL LIMIT 1) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Rollback 004 refused: payments collected by resellers would lose their reseller';
    END IF;
  END IF;
END $$
DELIMITER ;
CALL r004_refuse_with_ledger();
DROP PROCEDURE IF EXISTS r004_refuse_with_ledger;

-- role_permissions rows go with the permission (ON DELETE CASCADE).
DELETE FROM permissions WHERE name IN ('reseller_app.collect', 'reseller_ledger.view', 'reseller_ledger.manage');

DELETE FROM organization_settings WHERE setting_key = 'reseller_default_credit_limit';

DROP TABLE IF EXISTS reseller_ledger_entries;

DROP PROCEDURE IF EXISTS r004_reseller_columns;
DELIMITER $$
CREATE PROCEDURE r004_reseller_columns()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'fk_payments_reseller' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE payments DROP FOREIGN KEY fk_payments_reseller;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND INDEX_NAME = 'idx_payments_reseller_id'
  ) THEN
    ALTER TABLE payments DROP INDEX idx_payments_reseller_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'reseller_id'
  ) THEN
    ALTER TABLE payments DROP COLUMN reseller_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'credit_limit'
  ) THEN
    ALTER TABLE resellers DROP COLUMN credit_limit;
  END IF;
END $$
DELIMITER ;
CALL r004_reseller_columns();
DROP PROCEDURE IF EXISTS r004_reseller_columns;
