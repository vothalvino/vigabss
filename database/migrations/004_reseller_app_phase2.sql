-- =============================================================================
-- Migration 004 — reseller app, phase 2 (a Punto de Venta collects cash)
-- =============================================================================
-- A reseller is the ISP's commission agent. In phase 2 it collects cash from
-- the ISP's subscribers, within a credit limit: how much collected cash it
-- may hold before handing it over. The ISP stays the provider and the CFDI
-- issuer; the collection is an ordinary completed cash payment of the client.
--
--   * resellers.credit_limit — NULL uses the organization default (the
--     per-organization setting reseller_default_credit_limit, settingsCatalog).
--   * payments.reseller_id — the top-level reseller that collected the
--     payment; set only by the reseller app, never from a request body.
--   * reseller_ledger_entries — append-only ledger of what each collecting
--     reseller owes the ISP. amount is signed: a collection adds, its void
--     and a deposit (cash handed in) subtract, an adjustment does either.
--     Phase 3 adds 'bagged' and phase 4 'commission' and
--     'commission_reversal' to entry_type with ALTER TABLE ... MODIFY.
--   * reseller_app.collect (granted to reseller_admin and admin) and
--     reseller_ledger.view / reseller_ledger.manage (granted to admin, which
--     holds every non-platform permission).
--
-- Safe to re-run: the DDL is guarded and the seeds use INSERT IGNORE.
-- =============================================================================

DROP PROCEDURE IF EXISTS m004_reseller_columns;
DELIMITER $$
CREATE PROCEDURE m004_reseller_columns()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'credit_limit'
  ) THEN
    ALTER TABLE resellers ADD COLUMN credit_limit DECIMAL(12, 2) NULL DEFAULT NULL
      COMMENT 'Collected cash the reseller may hold before handing it in; NULL = organization default (migration 004)'
      AFTER commission_rate;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'reseller_id'
  ) THEN
    ALTER TABLE payments ADD COLUMN reseller_id BIGINT UNSIGNED NULL DEFAULT NULL
      COMMENT 'Top-level reseller that collected this payment in the reseller app; server-set only (migration 004)'
      AFTER recorded_by;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND INDEX_NAME = 'idx_payments_reseller_id'
  ) THEN
    ALTER TABLE payments ADD KEY idx_payments_reseller_id (reseller_id, created_at);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'fk_payments_reseller' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE payments ADD CONSTRAINT fk_payments_reseller FOREIGN KEY (reseller_id)
      REFERENCES resellers (id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$
DELIMITER ;
CALL m004_reseller_columns();
DROP PROCEDURE IF EXISTS m004_reseller_columns;

CREATE TABLE IF NOT EXISTS reseller_ledger_entries (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL COMMENT 'Organization of the reseller',
  reseller_id     BIGINT UNSIGNED NOT NULL COMMENT 'Collecting (top-level) reseller',
  entry_type      ENUM('collection', 'collection_void', 'deposit', 'adjustment') NOT NULL
                    COMMENT 'collection +, collection_void -, deposit -, adjustment +/-',
  amount          DECIMAL(12, 2)  NOT NULL COMMENT 'Signed: positive increases what the reseller owes the ISP',
  currency        CHAR(3)         NOT NULL COMMENT 'ISO 4217; the organization currency',
  payment_id      BIGINT UNSIGNED NULL     COMMENT 'The collected payment (collection, collection_void)',
  cash_session_id BIGINT UNSIGNED NULL     COMMENT 'The collecting user''s cash session (collection, collection_void)',
  note            VARCHAR(500)    NULL,
  created_by      BIGINT UNSIGNED NOT NULL COMMENT 'User who recorded the entry',
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_reseller_ledger_reseller_created (reseller_id, created_at),
  KEY idx_reseller_ledger_org (organization_id),
  KEY idx_reseller_ledger_payment (payment_id),
  KEY idx_reseller_ledger_cash_session (cash_session_id),
  KEY idx_reseller_ledger_created_by (created_by),
  CONSTRAINT fk_reseller_ledger_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_reseller_ledger_reseller FOREIGN KEY (reseller_id)
    REFERENCES resellers (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_reseller_ledger_payment FOREIGN KEY (payment_id)
    REFERENCES payments (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_reseller_ledger_cash_session FOREIGN KEY (cash_session_id)
    REFERENCES cash_reconciliation_sessions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_reseller_ledger_created_by FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Append-only cash ledger of a collecting reseller; the sum is what it owes the ISP (migration 004)';

INSERT IGNORE INTO permissions (name, description, module) VALUES
  ('reseller_app.collect', 'Collect cash from subscribers in the reseller app, void a same-day collection and close the cash box', 'reseller_app'),
  ('reseller_ledger.view', 'View a reseller''s cash ledger: collections, voids, deposits and adjustments', 'reseller_ledger'),
  ('reseller_ledger.manage', 'Record cash a reseller hands in (deposit) and ledger adjustments', 'reseller_ledger');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('reseller_app.collect')
 WHERE r.name = 'reseller_admin'
   AND r.is_system = 1;

-- admin holds every non-platform permission (seed invariant); the reseller
-- app still refuses any user that is not bound to a reseller.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('reseller_app.collect', 'reseller_ledger.view', 'reseller_ledger.manage')
 WHERE r.name = 'admin'
   AND r.is_system = 1;
