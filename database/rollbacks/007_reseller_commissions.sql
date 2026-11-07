-- Rollback 007 — removes the commission engine (reseller program, phase 4).
-- A commission, commission_reversal or payout line is money the reseller kept
-- or was paid, and a reseller_commissions row written by the engine (it has a
-- base_amount) is the record behind it. Neither can be restored once its
-- column or ENUM value is gone, and the ledger is append-only, so the rollback
-- refuses while any of them exists. Otherwise it removes the columns, keys and
-- ENUM values migration 007 added, puts status back to the four old values
-- (earned -> pending, reversed -> cancelled), makes created_by NOT NULL again
-- (no NULL can remain: only commission lines are posted without a user) and
-- deletes the go-live setting. Roll back only to recover from a failed
-- deploy, then roll forward.

DROP PROCEDURE IF EXISTS r007_refuse_with_commissions;
DELIMITER $$
CREATE PROCEDURE r007_refuse_with_commissions()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'entry_type'
       AND COLUMN_TYPE LIKE '%''payout''%'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM reseller_ledger_entries
       WHERE entry_type IN ('commission', 'commission_reversal', 'payout') LIMIT 1
    ) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Rollback 007 refused: the reseller ledger holds commission or payout lines';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'base_amount'
  ) THEN
    IF EXISTS (SELECT 1 FROM reseller_commissions WHERE base_amount IS NOT NULL LIMIT 1) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Rollback 007 refused: reseller_commissions holds commissions the engine recorded';
    END IF;
  END IF;
END $$
DELIMITER ;
CALL r007_refuse_with_commissions();
DROP PROCEDURE IF EXISTS r007_refuse_with_commissions;

DELETE FROM organization_settings WHERE setting_key = 'reseller_commissions_since';

DROP PROCEDURE IF EXISTS r007_reseller_ledger;
DELIMITER $$
CREATE PROCEDURE r007_reseller_ledger()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries'
       AND CONSTRAINT_NAME = 'fk_reseller_ledger_commission' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE reseller_ledger_entries DROP FOREIGN KEY fk_reseller_ledger_commission;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries'
       AND CONSTRAINT_NAME = 'fk_reseller_ledger_invoice' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE reseller_ledger_entries DROP FOREIGN KEY fk_reseller_ledger_invoice;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND INDEX_NAME = 'idx_reseller_ledger_commission'
  ) THEN
    ALTER TABLE reseller_ledger_entries DROP INDEX idx_reseller_ledger_commission;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND INDEX_NAME = 'idx_reseller_ledger_invoice'
  ) THEN
    ALTER TABLE reseller_ledger_entries DROP INDEX idx_reseller_ledger_invoice;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'commission_id'
  ) THEN
    ALTER TABLE reseller_ledger_entries DROP COLUMN commission_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'invoice_id'
  ) THEN
    ALTER TABLE reseller_ledger_entries DROP COLUMN invoice_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'created_by'
       AND IS_NULLABLE = 'YES'
  ) THEN
    ALTER TABLE reseller_ledger_entries MODIFY COLUMN created_by BIGINT UNSIGNED NOT NULL
      COMMENT 'User who recorded the entry';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'entry_type'
       AND COLUMN_TYPE LIKE '%''payout''%'
  ) THEN
    ALTER TABLE reseller_ledger_entries MODIFY COLUMN entry_type
      ENUM('collection', 'collection_void', 'deposit', 'adjustment', 'bag_sealed') NOT NULL
      COMMENT 'collection +, collection_void -, deposit -, adjustment +/-, bag_sealed - (migration 006)';
  END IF;
END $$
DELIMITER ;
CALL r007_reseller_ledger();
DROP PROCEDURE IF EXISTS r007_reseller_ledger;

DROP PROCEDURE IF EXISTS r007_reseller_commissions;
DELIMITER $$
CREATE PROCEDURE r007_reseller_commissions()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions'
       AND CONSTRAINT_NAME = 'fk_rc_organization' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE reseller_commissions DROP FOREIGN KEY fk_rc_organization;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND INDEX_NAME = 'idx_reseller_commissions_org_reseller_earned'
  ) THEN
    ALTER TABLE reseller_commissions DROP INDEX idx_reseller_commissions_org_reseller_earned;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'status'
       AND COLUMN_TYPE NOT LIKE '%''pending''%'
  ) THEN
    ALTER TABLE reseller_commissions MODIFY COLUMN status
      ENUM('pending', 'approved', 'paid', 'cancelled', 'earned', 'reversed') NOT NULL DEFAULT 'pending';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'status'
       AND COLUMN_TYPE LIKE '%''earned''%'
  ) THEN
    UPDATE reseller_commissions SET status = 'pending' WHERE status = 'earned';
    UPDATE reseller_commissions SET status = 'cancelled' WHERE status = 'reversed';
    ALTER TABLE reseller_commissions MODIFY COLUMN status
      ENUM('pending', 'approved', 'paid', 'cancelled') NOT NULL DEFAULT 'pending';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'reversed_at'
  ) THEN
    ALTER TABLE reseller_commissions DROP COLUMN reversed_at;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'earned_at'
  ) THEN
    ALTER TABLE reseller_commissions DROP COLUMN earned_at;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'base_amount'
  ) THEN
    ALTER TABLE reseller_commissions DROP COLUMN base_amount;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'organization_id'
  ) THEN
    ALTER TABLE reseller_commissions DROP COLUMN organization_id;
  END IF;
END $$
DELIMITER ;
CALL r007_reseller_commissions();
DROP PROCEDURE IF EXISTS r007_reseller_commissions;
