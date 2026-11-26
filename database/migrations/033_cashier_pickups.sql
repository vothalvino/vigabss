-- =============================================================================
-- Migration 033 — the cashier keeps its cash between shifts; pickups take it out
-- =============================================================================
-- Closing a cashier is a count, not a hand-in: the cash stays in the drawer
-- and the next shift starts by counting it again. Cash leaves the drawer only
-- when a supervisor picks it up, normally once it holds more than the
-- organization's threshold.
--
--   cash_reconciliation_sessions
--     opening_total     the cash counted when opening
--     opening_expected  the count of the agent's previous close, to compare
--     pickups_total     confirmed pickups of the session, fixed at close
--     expected_total    now opening_total + cash payments - pickups_total
--
--   cash_reconciliation_pickups   cash a supervisor took from an open cashier;
--                                 the owner confirms it before it counts
--
-- Sessions from before this migration keep opening_total NULL: their
-- expected_total is the payments alone, and their count is not carried into
-- the next opening.
--
-- Safe to re-run: each column and the table are added only when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m033_cashier_pickups;
DELIMITER $$
CREATE PROCEDURE m033_cashier_pickups()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cash_reconciliation_sessions' AND COLUMN_NAME = 'opening_total'
  ) THEN
    ALTER TABLE cash_reconciliation_sessions
      ADD COLUMN opening_total DECIMAL(12,2) NULL COMMENT 'Cash the agent counted in the drawer when opening; NULL on sessions from before migration 033'
        AFTER closed_at;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cash_reconciliation_sessions' AND COLUMN_NAME = 'opening_expected'
  ) THEN
    ALTER TABLE cash_reconciliation_sessions
      ADD COLUMN opening_expected DECIMAL(12,2) NULL COMMENT 'What the drawer should have held at opening: the count of the agent''s previous close; NULL when there was none to compare with (migration 033)'
        AFTER opening_total;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cash_reconciliation_sessions' AND COLUMN_NAME = 'pickups_total'
  ) THEN
    ALTER TABLE cash_reconciliation_sessions
      ADD COLUMN pickups_total DECIMAL(12,2) NULL COMMENT 'Cash handed to supervisors during the session (confirmed pickups), fixed at close (migration 033)'
        AFTER opening_expected;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cash_reconciliation_sessions' AND COLUMN_NAME = 'expected_total'
       AND COLUMN_COMMENT NOT LIKE '%migration 033%'
  ) THEN
    ALTER TABLE cash_reconciliation_sessions
      MODIFY COLUMN expected_total DECIMAL(12,2) NULL
        COMMENT 'Cash the drawer should hold at close: opening_total + cash payments of the session - pickups_total (payments alone before migration 033)';
  END IF;
END $$
DELIMITER ;
CALL m033_cashier_pickups();
DROP PROCEDURE IF EXISTS m033_cashier_pickups;

CREATE TABLE IF NOT EXISTS cash_reconciliation_pickups (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id BIGINT UNSIGNED NULL     COMMENT 'Owning tenant organisation (the session''s)',
    session_id      BIGINT UNSIGNED NOT NULL COMMENT 'The open cashier the cash was taken from',
    amount          DECIMAL(12,2)   NOT NULL,
    status          ENUM('pending','confirmed','cancelled') NOT NULL DEFAULT 'pending'
                        COMMENT 'pending = recorded by the supervisor, waiting for the owner; confirmed = counts; cancelled = never happened',
    taken_by        BIGINT UNSIGNED NOT NULL COMMENT 'Supervisor who took the cash',
    confirmed_by    BIGINT UNSIGNED NULL     COMMENT 'The cashier''s owner who confirmed it (the taker when an admin takes from their own)',
    confirmed_at    DATETIME        NULL,
    cancelled_by    BIGINT UNSIGNED NULL,
    cancelled_at    DATETIME        NULL,
    note            VARCHAR(500)    NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_cash_recon_pickups_session (session_id, status),
    KEY idx_cash_recon_pickups_org (organization_id),
    CONSTRAINT fk_cash_recon_pickups_session FOREIGN KEY (session_id)
        REFERENCES cash_reconciliation_sessions (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_cash_recon_pickups_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT chk_cash_recon_pickups_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Cash taken out of an open cashier by a supervisor (migration 033)';
