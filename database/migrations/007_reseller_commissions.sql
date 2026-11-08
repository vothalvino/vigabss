-- =============================================================================
-- Migration 007 — reseller program, phase 4: the commission engine
-- =============================================================================
-- A reseller (Punto de Venta) earns commission_rate % of the SUBTOTAL
-- (excluding taxes) of every invoice of a client it brought in
-- (clients.reseller_id), whoever collected the money. The rate and the
-- account are those of the TOP-LEVEL reseller (the root of parent_id), also
-- for clients of its sub-resellers. The reseller keeps its commission from
-- the cash it holds, so the commission is a line of its cash ledger:
--
--   commission           -amount  the invoice became paid
--   commission_reversal  +amount  the invoice stopped being paid
--   payout               +amount  the ISP paid the reseller what it owed
--                                 (staff, when the balance is negative)
--
-- services/resellerCommissionService.js is the only writer of
-- reseller_commissions and of the two commission lines. One row per
-- (reseller, invoice): paying the invoice again after a reversal restores the
-- row (reversed_at cleared) and posts a new commission line.
--
--   * reseller_commissions gains organization_id (from the reseller, else the
--     invoice), base_amount (the subtotal the rate applies to), earned_at and
--     reversed_at; status becomes earned / reversed (the old pending,
--     approved and paid were never written: nothing called the old hook).
--     settlement_id comes with the statements of phase 5.
--   * reseller_ledger_entries gains the three entry types, invoice_id and
--     commission_id, and created_by may be NULL: a commission line is posted
--     by the system (a gateway webhook, a SAT acknowledgement, ...).
--   * Go-live: the organization setting reseller_commissions_since (UTC
--     'YYYY-MM-DD HH:MM:SS', not in the settings catalog, so no route shows
--     or edits it) is written for every organization of this database. Only
--     an invoice whose paid_at is at or after it earns a commission: there is
--     no backfill of invoices paid before this upgrade, and the phase 5 gap
--     sweep bounds itself by it. An organization created later has no row
--     and earns from its creation (organizations.created_at); an invoice
--     without paid_at never earns.
--
-- Runs on the primary database and, with MIGRATE_ISOLATED_TENANTS, on every
-- isolated organization database (src/scripts/migrate.js). Safe to re-run:
-- every DDL step is guarded, the backfills touch only rows still missing the
-- value, and the setting is INSERT IGNORE.
-- =============================================================================

DROP PROCEDURE IF EXISTS m007_reseller_commissions;
DELIMITER $$
CREATE PROCEDURE m007_reseller_commissions()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'organization_id'
  ) THEN
    ALTER TABLE reseller_commissions ADD COLUMN organization_id BIGINT UNSIGNED NULL DEFAULT NULL
      COMMENT 'Organization of the reseller (migration 007)'
      AFTER id;
  END IF;

  UPDATE reseller_commissions rc
    JOIN resellers r ON r.id = rc.reseller_id
     SET rc.organization_id = r.organization_id
   WHERE rc.organization_id IS NULL AND r.organization_id IS NOT NULL;
  UPDATE reseller_commissions rc
    JOIN invoices i ON i.id = rc.invoice_id
     SET rc.organization_id = i.organization_id
   WHERE rc.organization_id IS NULL AND i.organization_id IS NOT NULL;

  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'organization_id'
       AND IS_NULLABLE = 'YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM reseller_commissions WHERE organization_id IS NULL LIMIT 1) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration 007: a reseller_commissions row has no organization (neither its reseller nor its invoice has one); set it, then migrate again';
    END IF;
    ALTER TABLE reseller_commissions MODIFY COLUMN organization_id BIGINT UNSIGNED NOT NULL
      COMMENT 'Organization of the reseller (migration 007)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'base_amount'
  ) THEN
    ALTER TABLE reseller_commissions ADD COLUMN base_amount DECIMAL(12, 2) NULL DEFAULT NULL
      COMMENT 'Invoice subtotal, excluding taxes, the rate applies to; NULL on rows older than migration 007'
      AFTER commission_rate;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'earned_at'
  ) THEN
    ALTER TABLE reseller_commissions ADD COLUMN earned_at TIMESTAMP NULL DEFAULT NULL
      COMMENT 'When the commission last became standing: the invoice was paid (migration 007)'
      AFTER notes;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'reversed_at'
  ) THEN
    ALTER TABLE reseller_commissions ADD COLUMN reversed_at TIMESTAMP NULL DEFAULT NULL
      COMMENT 'Set while the invoice is no longer paid; cleared when it is paid again (migration 007)'
      AFTER earned_at;
  END IF;

  -- status: pending / approved / paid / cancelled -> earned / reversed.
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'status'
       AND COLUMN_TYPE NOT LIKE '%''earned''%'
  ) THEN
    ALTER TABLE reseller_commissions MODIFY COLUMN status
      ENUM('pending', 'approved', 'paid', 'cancelled', 'earned', 'reversed') NOT NULL DEFAULT 'pending';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND COLUMN_NAME = 'status'
       AND COLUMN_TYPE LIKE '%''pending''%'
  ) THEN
    UPDATE reseller_commissions
       SET status = 'reversed', reversed_at = COALESCE(reversed_at, updated_at)
     WHERE status = 'cancelled';
    UPDATE reseller_commissions
       SET status = 'earned', earned_at = COALESCE(earned_at, created_at)
     WHERE status IN ('pending', 'approved', 'paid');
    ALTER TABLE reseller_commissions MODIFY COLUMN status
      ENUM('earned', 'reversed') NOT NULL DEFAULT 'earned'
      COMMENT 'earned while the invoice is paid, reversed while it is not (migration 007)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions' AND INDEX_NAME = 'idx_reseller_commissions_org_reseller_earned'
  ) THEN
    ALTER TABLE reseller_commissions ADD KEY idx_reseller_commissions_org_reseller_earned (organization_id, reseller_id, earned_at);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_commissions'
       AND CONSTRAINT_NAME = 'fk_rc_organization' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE reseller_commissions ADD CONSTRAINT fk_rc_organization FOREIGN KEY (organization_id)
      REFERENCES organizations (id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$
DELIMITER ;
CALL m007_reseller_commissions();
DROP PROCEDURE IF EXISTS m007_reseller_commissions;

DROP PROCEDURE IF EXISTS m007_reseller_ledger;
DELIMITER $$
CREATE PROCEDURE m007_reseller_ledger()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'entry_type'
       AND COLUMN_TYPE NOT LIKE '%''payout''%'
  ) THEN
    ALTER TABLE reseller_ledger_entries MODIFY COLUMN entry_type
      ENUM('collection', 'collection_void', 'deposit', 'adjustment', 'bag_sealed', 'commission', 'commission_reversal', 'payout') NOT NULL
      COMMENT 'collection +, collection_void -, deposit -, adjustment +/-, bag_sealed - (006), commission -, commission_reversal +, payout + (007)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'created_by'
       AND IS_NULLABLE = 'NO'
  ) THEN
    ALTER TABLE reseller_ledger_entries MODIFY COLUMN created_by BIGINT UNSIGNED NULL DEFAULT NULL
      COMMENT 'User who recorded the entry; NULL = posted by the system (commission lines, migration 007)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'invoice_id'
  ) THEN
    ALTER TABLE reseller_ledger_entries ADD COLUMN invoice_id BIGINT UNSIGNED NULL DEFAULT NULL
      COMMENT 'The invoice behind a commission or commission_reversal (migration 007)'
      AFTER cash_bag_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'commission_id'
  ) THEN
    ALTER TABLE reseller_ledger_entries ADD COLUMN commission_id BIGINT UNSIGNED NULL DEFAULT NULL
      COMMENT 'The reseller_commissions row a commission or commission_reversal books (migration 007)'
      AFTER invoice_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND INDEX_NAME = 'idx_reseller_ledger_invoice'
  ) THEN
    ALTER TABLE reseller_ledger_entries ADD KEY idx_reseller_ledger_invoice (invoice_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND INDEX_NAME = 'idx_reseller_ledger_commission'
  ) THEN
    ALTER TABLE reseller_ledger_entries ADD KEY idx_reseller_ledger_commission (commission_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries'
       AND CONSTRAINT_NAME = 'fk_reseller_ledger_invoice' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE reseller_ledger_entries ADD CONSTRAINT fk_reseller_ledger_invoice FOREIGN KEY (invoice_id)
      REFERENCES invoices (id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries'
       AND CONSTRAINT_NAME = 'fk_reseller_ledger_commission' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE reseller_ledger_entries ADD CONSTRAINT fk_reseller_ledger_commission FOREIGN KEY (commission_id)
      REFERENCES reseller_commissions (id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$
DELIMITER ;
CALL m007_reseller_ledger();
DROP PROCEDURE IF EXISTS m007_reseller_ledger;

-- Go-live of the commission engine, per organization (see the header).
INSERT IGNORE INTO organization_settings (organization_id, setting_key, setting_value)
SELECT o.id, 'reseller_commissions_since', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s')
  FROM organizations o;
