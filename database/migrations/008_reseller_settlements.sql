-- =============================================================================
-- Migration 008 — reseller program, phase 5: statements and settlement
-- =============================================================================
-- A statement (estado de cuenta) closes a period of a top-level reseller's
-- cash ledger (reseller_ledger_entries; the ledger is booked on the top-level
-- reseller, so a sub-reseller has none). Its figures are rebuilt from the
-- ledger, never typed in:
--
--   opening_balance = SUM(amount) of the entries created before the period
--   total_<type>    = SUM(amount) of the period's entries of that type
--   closing_balance = opening_balance + the sum of every total_<type>
--
-- The period is business days of the organization's time zone and must have
-- ended before it is generated; ledger lines are always created "now", so a
-- line posted later (a late commission reversal) falls in a later statement
-- and an approved statement never changes. Status:
--
--   draft     generated; may be regenerated or voided (discarded)
--   approved  figures frozen (reseller_settlements.approve)
--   settled   the transfer that squares the closing balance was recorded:
--             a deposit (the reseller owed the ISP) or a payout (the ISP owed
--             the reseller) line, settlement_entry_id; or record_only, when
--             staff had already recorded that money by hand
--   void      a discarded draft (kept for the audit trail)
--
-- services/resellerSettlementService.js is the only writer.
--
-- Permissions: reseller_settlements.view / .manage / .approve (staff) and
-- reseller_app.statements (the reseller sees its approved and settled
-- statements in the reseller app).
--
-- Safe to re-run: the table is CREATE IF NOT EXISTS and the seeds INSERT IGNORE.
-- =============================================================================

CREATE TABLE IF NOT EXISTS reseller_settlements (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id           BIGINT UNSIGNED NOT NULL COMMENT 'Organization of the reseller',
  reseller_id               BIGINT UNSIGNED NOT NULL COMMENT 'Top-level reseller whose ledger the statement closes',
  period_start              DATE            NOT NULL COMMENT 'First business day of the period (organization time zone)',
  period_end                DATE            NOT NULL COMMENT 'Last business day of the period, inclusive',
  currency                  CHAR(3)         NOT NULL COMMENT 'ISO 4217; the organization currency',
  opening_balance           DECIMAL(14, 2)  NOT NULL DEFAULT 0 COMMENT 'SUM(amount) of the ledger before the period',
  total_collection          DECIMAL(14, 2)  NOT NULL DEFAULT 0,
  total_collection_void     DECIMAL(14, 2)  NOT NULL DEFAULT 0,
  total_deposit             DECIMAL(14, 2)  NOT NULL DEFAULT 0,
  total_adjustment          DECIMAL(14, 2)  NOT NULL DEFAULT 0,
  total_bag_sealed          DECIMAL(14, 2)  NOT NULL DEFAULT 0,
  total_commission          DECIMAL(14, 2)  NOT NULL DEFAULT 0,
  total_commission_reversal DECIMAL(14, 2)  NOT NULL DEFAULT 0,
  total_payout              DECIMAL(14, 2)  NOT NULL DEFAULT 0,
  closing_balance           DECIMAL(14, 2)  NOT NULL DEFAULT 0 COMMENT 'opening_balance + every total; positive: the reseller owes the ISP',
  entry_count               INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Ledger entries in the period',
  sweep_earned              INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Missing commissions the gap sweep booked before generating',
  sweep_reversed            INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Stale commissions the gap sweep reversed before generating',
  status                    ENUM('draft', 'approved', 'settled', 'void') NOT NULL DEFAULT 'draft',
  generated_by              BIGINT UNSIGNED NULL,
  generated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_by               BIGINT UNSIGNED NULL,
  approved_at               TIMESTAMP       NULL DEFAULT NULL,
  settled_by                BIGINT UNSIGNED NULL,
  settled_at                TIMESTAMP       NULL DEFAULT NULL,
  bank_ref                  VARCHAR(100)    NULL COMMENT 'Bank or transfer reference of the settlement',
  settlement_entry_id       BIGINT UNSIGNED NULL COMMENT 'The deposit or payout line settling posted (NULL: nothing to post, or record only)',
  voided_by                 BIGINT UNSIGNED NULL,
  voided_at                 TIMESTAMP       NULL DEFAULT NULL,
  notes                     VARCHAR(500)    NULL,
  created_at                TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_reseller_settlements_org_reseller_period (organization_id, reseller_id, period_start),
  KEY idx_reseller_settlements_reseller (reseller_id),
  KEY idx_reseller_settlements_entry (settlement_entry_id),
  KEY idx_reseller_settlements_generated_by (generated_by),
  KEY idx_reseller_settlements_approved_by (approved_by),
  KEY idx_reseller_settlements_settled_by (settled_by),
  KEY idx_reseller_settlements_voided_by (voided_by),
  CONSTRAINT fk_reseller_settlements_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_reseller_settlements_reseller FOREIGN KEY (reseller_id)
    REFERENCES resellers (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_reseller_settlements_entry FOREIGN KEY (settlement_entry_id)
    REFERENCES reseller_ledger_entries (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_reseller_settlements_generated_by FOREIGN KEY (generated_by)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_reseller_settlements_approved_by FOREIGN KEY (approved_by)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_reseller_settlements_settled_by FOREIGN KEY (settled_by)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_reseller_settlements_voided_by FOREIGN KEY (voided_by)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Statements of a top-level reseller cash ledger: draft, approved, settled (migration 008)';

INSERT IGNORE INTO permissions (name, description, module) VALUES
  ('reseller_settlements.view', 'View reseller statements (estados de cuenta), their lines and PDF', 'reseller_settlements'),
  ('reseller_settlements.manage', 'Generate, regenerate and discard reseller statements, run the commission gap sweep and record a settlement', 'reseller_settlements'),
  ('reseller_settlements.approve', 'Approve a reseller statement, freezing its figures', 'reseller_settlements'),
  ('reseller_app.statements', 'See the reseller''s approved and settled statements and their PDF in the reseller app', 'reseller_app');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('reseller_app.statements')
 WHERE r.name = 'reseller_admin'
   AND r.is_system = 1;

-- admin holds every non-platform permission (seed invariant); the reseller
-- app still refuses any user that is not bound to a reseller.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN (
    'reseller_settlements.view', 'reseller_settlements.manage', 'reseller_settlements.approve',
    'reseller_app.statements'
  )
 WHERE r.name = 'admin'
   AND r.is_system = 1;
