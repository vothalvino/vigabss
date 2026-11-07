-- Rollback 006 — sealing a cash bag books nothing again (migration 005 rules).
-- The 'bag_sealed' ledger lines cannot stay once the ENUM loses the value, and
-- the reseller ledger is append-only money history, so none is deleted.
-- Instead, in one transaction, each line is rewritten to the shape the 005
-- code expects for its bag, keeping its amount, bag, author, note and date:
--
--   * bag received:         'bag_sealed' -D becomes the 'deposit' -D the 005
--     receipt would have posted (its adjustment for a difference is kept).
--   * bag still sealed or travelling (ready_for_pickup, in_transit):
--     'bag_sealed' -D becomes an 'adjustment' -D, and a compensating
--     'adjustment' +D is appended, so the balance again counts D, which the
--     005 code takes off as in_bags and books as a deposit on receipt.
--   * bag lost:             'bag_sealed' -D becomes an 'adjustment' -D: the
--     ISP has already absorbed the loss (under 005 an administrator records
--     that adjustment by hand).
--
-- Every reseller's balance is therefore what the 005 code would show for the
-- same bags. Then entry_type goes back to its four 005 values. Safe to re-run:
-- once no 'bag_sealed' line is left the data step does nothing. Roll back only
-- to recover from a failed deploy, then roll forward.

DROP PROCEDURE IF EXISTS r006_bag_sealed_lines;
DELIMITER $$
CREATE PROCEDURE r006_bag_sealed_lines()
BEGIN
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'entry_type'
       AND COLUMN_TYPE LIKE '%''bag_sealed''%'
  ) THEN
    START TRANSACTION;
    INSERT INTO reseller_ledger_entries
      (organization_id, reseller_id, entry_type, amount, currency, payment_id, cash_session_id, note, created_by, cash_bag_id)
    SELECT e.organization_id, e.reseller_id, 'adjustment', -e.amount, e.currency, NULL, NULL,
           CONCAT('Rollback 006: bolsa ', b.serial, ' vuelve a contar como en bolsas'), e.created_by, e.cash_bag_id
      FROM reseller_ledger_entries e
      JOIN cash_bags b ON b.id = e.cash_bag_id
     WHERE e.entry_type = 'bag_sealed'
       AND b.status IN ('ready_for_pickup', 'in_transit');
    UPDATE reseller_ledger_entries e
      JOIN cash_bags b ON b.id = e.cash_bag_id
       SET e.entry_type = 'deposit'
     WHERE e.entry_type = 'bag_sealed'
       AND b.status = 'received';
    UPDATE reseller_ledger_entries
       SET entry_type = 'adjustment'
     WHERE entry_type = 'bag_sealed';
    COMMIT;
  END IF;
END $$
DELIMITER ;
CALL r006_bag_sealed_lines();
DROP PROCEDURE IF EXISTS r006_bag_sealed_lines;

DROP PROCEDURE IF EXISTS r006_entry_type;
DELIMITER $$
CREATE PROCEDURE r006_entry_type()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'entry_type'
       AND COLUMN_TYPE LIKE '%''bag_sealed''%'
  ) THEN
    ALTER TABLE reseller_ledger_entries MODIFY COLUMN entry_type
      ENUM('collection', 'collection_void', 'deposit', 'adjustment') NOT NULL
      COMMENT 'collection +, collection_void -, deposit -, adjustment +/-';
  END IF;
END $$
DELIMITER ;
CALL r006_entry_type();
DROP PROCEDURE IF EXISTS r006_entry_type;
