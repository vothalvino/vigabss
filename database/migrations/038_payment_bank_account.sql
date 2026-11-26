-- =============================================================================
-- Migration 038 — a payment names the bank account it reached
-- =============================================================================
-- A payment by transfer, card or check goes straight to a bank account. The
-- money tie-out could only show cash deposits per account, because nothing
-- said which account such a payment reached:
--
--   payments.bank_account_id   the organization's bank account the money
--                              landed in; NULL for cash (it reaches the bank
--                              as a deposit from the safe) and when not stated
--
-- Safe to re-run: the column, its index and its foreign key are added only
-- when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m038_payment_bank_account;
DELIMITER $$
CREATE PROCEDURE m038_payment_bank_account()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'bank_account_id'
  ) THEN
    ALTER TABLE payments
      ADD COLUMN bank_account_id BIGINT UNSIGNED NULL DEFAULT NULL
        COMMENT 'The bank account a non-cash payment reached; NULL for cash and when not stated (migration 038)'
        AFTER bank_name,
      ADD KEY idx_payments_bank_account (bank_account_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND CONSTRAINT_NAME = 'fk_payments_bank_account'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT fk_payments_bank_account FOREIGN KEY (bank_account_id)
        REFERENCES bank_accounts (id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$
DELIMITER ;
CALL m038_payment_bank_account();
DROP PROCEDURE IF EXISTS m038_payment_bank_account;
