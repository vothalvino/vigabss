-- Rollback 038 — payments no longer name a bank account. The payments stay.

DROP PROCEDURE IF EXISTS r038_payment_bank_account;
DELIMITER $$
CREATE PROCEDURE r038_payment_bank_account()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND CONSTRAINT_NAME = 'fk_payments_bank_account'
  ) THEN
    ALTER TABLE payments DROP FOREIGN KEY fk_payments_bank_account;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'bank_account_id'
  ) THEN
    ALTER TABLE payments DROP KEY idx_payments_bank_account, DROP COLUMN bank_account_id;
  END IF;
END $$
DELIMITER ;
CALL r038_payment_bank_account();
DROP PROCEDURE IF EXISTS r038_payment_bank_account;
