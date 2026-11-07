-- Rollback 005 — removes the reseller app, phase 3 (cash bags and carriers).
-- A bag that left in_stock carries money history (a reseller sealed cash in
-- it, a carrier holds it, or the ISP received it), and a ledger entry that
-- names a bag is a deposit or adjustment of cash handed in. Neither can be
-- restored once dropped, so the rollback refuses while either exists. What is
-- lost otherwise: bags still in stock and their registration events, carrier
-- assignments, and the resellers' address, city and coordinates. The carrier
-- user group is removed only when no user belongs to it; a remaining one keeps
-- the group with no permissions (deny-all). Roll back only to recover from a
-- failed deploy, then roll forward.

DROP PROCEDURE IF EXISTS r005_refuse_with_bags;
DELIMITER $$
CREATE PROCEDURE r005_refuse_with_bags()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cash_bags'
  ) THEN
    IF EXISTS (SELECT 1 FROM cash_bags WHERE status <> 'in_stock' LIMIT 1) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Rollback 005 refused: cash bags have left stock and carry money history';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'cash_bag_id'
  ) THEN
    IF EXISTS (SELECT 1 FROM reseller_ledger_entries WHERE cash_bag_id IS NOT NULL LIMIT 1) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Rollback 005 refused: reseller ledger entries record received cash bags';
    END IF;
  END IF;
END $$
DELIMITER ;
CALL r005_refuse_with_bags();
DROP PROCEDURE IF EXISTS r005_refuse_with_bags;

DROP PROCEDURE IF EXISTS r005_ledger_cash_bag;
DELIMITER $$
CREATE PROCEDURE r005_ledger_cash_bag()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries'
       AND CONSTRAINT_NAME = 'fk_reseller_ledger_cash_bag' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE reseller_ledger_entries DROP FOREIGN KEY fk_reseller_ledger_cash_bag;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND INDEX_NAME = 'idx_reseller_ledger_cash_bag'
  ) THEN
    ALTER TABLE reseller_ledger_entries DROP INDEX idx_reseller_ledger_cash_bag;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'cash_bag_id'
  ) THEN
    ALTER TABLE reseller_ledger_entries DROP COLUMN cash_bag_id;
  END IF;
END $$
DELIMITER ;
CALL r005_ledger_cash_bag();
DROP PROCEDURE IF EXISTS r005_ledger_cash_bag;

DROP TABLE IF EXISTS cash_bag_events;
DROP TABLE IF EXISTS carrier_reseller_assignments;
DROP TABLE IF EXISTS cash_bags;

-- role_permissions rows go with the permission (ON DELETE CASCADE); the
-- carrier group's passkey grants are removed explicitly.
DELETE FROM permissions WHERE name IN (
  'carrier_app.use', 'carrier_app.pickup', 'cash_bags.view', 'cash_bags.manage',
  'cash_bags.receive', 'carriers.manage', 'reseller_app.bags'
);

DELETE rp
  FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id
 WHERE r.name = 'carrier'
   AND r.is_system = 1;

DELETE r
  FROM roles r
  LEFT JOIN users u ON u.group_id = r.id
 WHERE r.name = 'carrier'
   AND r.is_system = 1
   AND u.id IS NULL;

DROP PROCEDURE IF EXISTS r005_reseller_location;
DELIMITER $$
CREATE PROCEDURE r005_reseller_location()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'longitude'
  ) THEN
    ALTER TABLE resellers DROP COLUMN longitude;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'latitude'
  ) THEN
    ALTER TABLE resellers DROP COLUMN latitude;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'city'
  ) THEN
    ALTER TABLE resellers DROP COLUMN city;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'address'
  ) THEN
    ALTER TABLE resellers DROP COLUMN address;
  END IF;
END $$
DELIMITER ;
CALL r005_reseller_location();
DROP PROCEDURE IF EXISTS r005_reseller_location;
