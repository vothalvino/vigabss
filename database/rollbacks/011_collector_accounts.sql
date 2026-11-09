-- Rollback 011 — removes collector accounts. A collector, or a ledger line of
-- a collection fee, is money history the earlier schema cannot hold (the
-- collector would turn into a reseller, the fee lines would fail the entry
-- type), so the rollback refuses while either exists. The collector user
-- group is removed only when nobody is in it. Roll back only to recover from a
-- failed deploy, then roll forward.

DROP PROCEDURE IF EXISTS r011_refuse;
DELIMITER $$
CREATE PROCEDURE r011_refuse()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'kind'
  ) THEN
    IF EXISTS (SELECT 1 FROM resellers WHERE kind = 'collector' LIMIT 1) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Rollback 011 refused: collector accounts exist';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'entry_type'
       AND COLUMN_TYPE LIKE '%''collection_fee''%'
  ) THEN
    IF EXISTS (SELECT 1 FROM reseller_ledger_entries WHERE entry_type IN ('collection_fee', 'collection_fee_reversal') LIMIT 1) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Rollback 011 refused: the reseller ledger records collection fees';
    END IF;
  END IF;
END $$
DELIMITER ;
CALL r011_refuse();
DROP PROCEDURE IF EXISTS r011_refuse;

DROP PROCEDURE IF EXISTS r011_schema;
DELIMITER $$
CREATE PROCEDURE r011_schema()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_settlements' AND COLUMN_NAME = 'total_collection_fee_reversal'
  ) THEN
    ALTER TABLE reseller_settlements DROP COLUMN total_collection_fee_reversal;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_settlements' AND COLUMN_NAME = 'total_collection_fee'
  ) THEN
    ALTER TABLE reseller_settlements DROP COLUMN total_collection_fee;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'entry_type'
       AND COLUMN_TYPE LIKE '%''collection_fee''%'
  ) THEN
    ALTER TABLE reseller_ledger_entries MODIFY COLUMN entry_type
      ENUM('collection', 'collection_void', 'deposit', 'adjustment', 'bag_sealed', 'commission', 'commission_reversal', 'payout') NOT NULL
      COMMENT 'collection +, collection_void -, deposit -, adjustment +/-, bag_sealed - (006), commission -, commission_reversal +, payout + (007)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND INDEX_NAME = 'idx_resellers_org_kind'
  ) THEN
    ALTER TABLE resellers DROP KEY idx_resellers_org_kind;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'collection_fee_value'
  ) THEN
    ALTER TABLE resellers DROP COLUMN collection_fee_value;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'collection_fee_type'
  ) THEN
    ALTER TABLE resellers DROP COLUMN collection_fee_type;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'kind'
  ) THEN
    ALTER TABLE resellers DROP COLUMN kind;
  END IF;
END $$
DELIMITER ;
CALL r011_schema();
DROP PROCEDURE IF EXISTS r011_schema;

-- role_permissions rows go with the permission (ON DELETE CASCADE).
DELETE FROM permissions WHERE name IN ('reseller_app.cash');

DELETE rp
  FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id
 WHERE r.name = 'collector'
   AND r.is_system = 1;

DELETE r
  FROM roles r
  LEFT JOIN users u ON u.group_id = r.id
 WHERE r.name = 'collector'
   AND r.is_system = 1
   AND u.id IS NULL;
