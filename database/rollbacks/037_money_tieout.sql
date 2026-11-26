-- Rollback 037 — drops the safe movements and the bank accounts. The cashier,
-- cash bag and point ledger records are not touched.

DROP TABLE IF EXISTS cash_safe_movements;
DROP TABLE IF EXISTS bank_accounts;
