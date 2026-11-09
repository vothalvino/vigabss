-- =============================================================================
-- Migration 011 — collector accounts ("Cobrador")
-- =============================================================================
-- A collector is a point that only takes payments: its own business, like a
-- corner store, with its own cash limit, ledger, cash box, cash bags and
-- statements, exactly like a top-level reseller. It cannot see the ISP's
-- clients, the active/suspended/overdue counts or prospects, and it charges a
-- customer only by the customer's exact client number. It never owns clients,
-- leads or sub-resellers.
--
-- 1. resellers.kind ('reseller' | 'collector'). A collector is a top-level row
--    of the same table, so the ledger, the cash bags, the carriers and the
--    statements work unchanged.
-- 2. resellers.collection_fee_type ('none' | 'fixed' | 'percent') and
--    collection_fee_value: what a collector earns for each payment it takes,
--    a fixed amount or a percentage of the amount, set per collector.
-- 3. reseller_ledger_entries.entry_type gains 'collection_fee' (-, kept from
--    the cash, posted with the collection) and 'collection_fee_reversal'
--    (+, posted when that collection is voided).
-- 4. reseller_settlements gains their statement totals.
-- 5. Permission reseller_app.cash (the reseller app's cash routes: /me, the
--    day's payments and receipts, the cash box and the ledger) for
--    reseller_admin, admin and the new system group 'collector', which also
--    holds reseller_app.collect, reseller_app.bags, reseller_app.statements and
--    its own passkeys, and never reseller_app.use (clients, leads, plans).
--
-- Safe to re-run: every DDL step is guarded and the seeds INSERT IGNORE.
-- =============================================================================

DROP PROCEDURE IF EXISTS m011_collectors;
DELIMITER $$
CREATE PROCEDURE m011_collectors()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'kind'
  ) THEN
    ALTER TABLE resellers ADD COLUMN kind ENUM('reseller', 'collector') NOT NULL DEFAULT 'reseller'
      COMMENT 'reseller: signs up and owns clients; collector: only takes payments (migration 011)' AFTER level;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'collection_fee_type'
  ) THEN
    ALTER TABLE resellers ADD COLUMN collection_fee_type ENUM('none', 'fixed', 'percent') NOT NULL DEFAULT 'none'
      COMMENT 'What a collector earns per payment it takes (migration 011)' AFTER commission_rate;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'collection_fee_value'
  ) THEN
    ALTER TABLE resellers ADD COLUMN collection_fee_value DECIMAL(10, 2) NOT NULL DEFAULT 0.00
      COMMENT 'The fixed amount, or the percentage of each payment (migration 011)' AFTER collection_fee_type;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND INDEX_NAME = 'idx_resellers_org_kind'
  ) THEN
    ALTER TABLE resellers ADD KEY idx_resellers_org_kind (organization_id, kind);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'entry_type'
       AND COLUMN_TYPE NOT LIKE '%''collection_fee''%'
  ) THEN
    ALTER TABLE reseller_ledger_entries MODIFY COLUMN entry_type
      ENUM('collection', 'collection_void', 'deposit', 'adjustment', 'bag_sealed', 'commission', 'commission_reversal', 'payout', 'collection_fee', 'collection_fee_reversal') NOT NULL
      COMMENT 'collection +, collection_void -, deposit -, adjustment +/-, bag_sealed - (006), commission -, commission_reversal +, payout + (007), collection_fee -, collection_fee_reversal + (011)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_settlements' AND COLUMN_NAME = 'total_collection_fee'
  ) THEN
    ALTER TABLE reseller_settlements ADD COLUMN total_collection_fee DECIMAL(14, 2) NOT NULL DEFAULT 0 AFTER total_payout;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_settlements' AND COLUMN_NAME = 'total_collection_fee_reversal'
  ) THEN
    ALTER TABLE reseller_settlements ADD COLUMN total_collection_fee_reversal DECIMAL(14, 2) NOT NULL DEFAULT 0 AFTER total_collection_fee;
  END IF;
END $$
DELIMITER ;
CALL m011_collectors();
DROP PROCEDURE IF EXISTS m011_collectors;

INSERT IGNORE INTO roles (name, description, kind, is_system) VALUES
  ('collector', 'Collector — a point that only takes payments by client number (reseller app: Cobrar, Mi caja, Mis bolsas)', 'billing', 1);

INSERT IGNORE INTO permissions (name, description, module) VALUES
  ('reseller_app.cash', 'See the point''s cash in the reseller app: its money, the day''s payments and receipts, the cash box and the ledger', 'reseller_app');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN (
    'reseller_app.cash', 'reseller_app.collect', 'reseller_app.bags', 'reseller_app.statements',
    'webauthn.view', 'webauthn.create', 'webauthn.delete'
  )
 WHERE r.name = 'collector'
   AND r.is_system = 1;

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('reseller_app.cash')
 WHERE r.name = 'reseller_admin'
   AND r.is_system = 1;

-- admin holds every non-platform permission (seed invariant).
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('reseller_app.cash')
 WHERE r.name = 'admin'
   AND r.is_system = 1;

-- manager gets what admin gets (migration 010).
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('reseller_app.cash')
 WHERE r.name = 'manager'
   AND r.is_system = 1;
