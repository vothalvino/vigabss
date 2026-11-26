-- =============================================================================
-- Migration 037 — cash is followed to the bank
-- =============================================================================
-- Cash was tracked until it reached the company: a point's ledger, a cash bag,
-- a cashier's drawer, a supervisor's pickup. Nothing recorded the safe or the
-- bank deposit, so a month's collections could not be tied to the bank.
--
--   bank_accounts         the organization's bank accounts, each with what it
--                         is for (client invoices, General Public, or any)
--   cash_safe_movements   the safe: a count (what is in it), a deposit into a
--                         bank account, and other cash in or out. Cash arrives
--                         in the safe from confirmed cashier pickups, received
--                         cash bags and cash a point hands in, which stay in
--                         their own tables.
--
-- Safe to re-run: both tables are created only when missing.
-- =============================================================================

CREATE TABLE IF NOT EXISTS bank_accounts (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id BIGINT UNSIGNED NOT NULL COMMENT 'Owning tenant organisation',
    name            VARCHAR(100)    NOT NULL COMMENT 'What staff call the account',
    bank_name       VARCHAR(100)    NULL,
    account_hint    VARCHAR(20)     NULL     COMMENT 'Last digits or another short hint; never the full account number',
    purpose         ENUM('client_invoices','general_public','any') NOT NULL DEFAULT 'any'
                        COMMENT 'client_invoices = money invoiced to a client RFC; general_public = money invoiced to General Public; any = no split',
    status          ENUM('active','inactive') NOT NULL DEFAULT 'active',
    created_by      BIGINT UNSIGNED NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at      DATETIME        NULL,

    PRIMARY KEY (id),
    KEY idx_bank_accounts_org (organization_id, status),
    CONSTRAINT fk_bank_accounts_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_bank_accounts_created_by FOREIGN KEY (created_by)
        REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Bank accounts of an organization, for the money tie-out (migration 037)';

CREATE TABLE IF NOT EXISTS cash_safe_movements (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id BIGINT UNSIGNED NOT NULL COMMENT 'Owning tenant organisation',
    kind            ENUM('count','deposit','other_in','other_out') NOT NULL
                        COMMENT 'count = the cash counted in the safe; deposit = cash taken to a bank account; other_in / other_out = any other cash into or out of the safe',
    amount          DECIMAL(12,2)   NOT NULL,
    expected_amount DECIMAL(12,2)   NULL     COMMENT 'count only: what the safe should have held at that moment',
    bank_account_id BIGINT UNSIGNED NULL     COMMENT 'deposit only: the account the cash went to',
    moved_at        DATETIME        NOT NULL COMMENT 'When it happened (UTC)',
    reference       VARCHAR(100)    NULL     COMMENT 'Deposit slip or other reference',
    note            VARCHAR(500)    NULL,
    created_by      BIGINT UNSIGNED NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at      DATETIME        NULL     COMMENT 'Set when the movement is removed as a mistake',

    PRIMARY KEY (id),
    KEY idx_cash_safe_movements_org (organization_id, moved_at),
    KEY idx_cash_safe_movements_account (bank_account_id),
    CONSTRAINT fk_cash_safe_movements_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_cash_safe_movements_account FOREIGN KEY (bank_account_id)
        REFERENCES bank_accounts (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_cash_safe_movements_created_by FOREIGN KEY (created_by)
        REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT chk_cash_safe_movements_amount CHECK (amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='The safe: counts, bank deposits and other cash in or out (migration 037)';
