-- =============================================================================
-- Migration 043 — a cashier's cash limit is set per person
-- =============================================================================
-- The cash a cashier may hold before it should be handed in, and whether a
-- cashier over that amount is stopped or only reminded, were one setting for
-- the whole organization. A supervisor now sets them for each person:
--
--   cashier_user_limits   one row per person who has their own limit:
--       pickup_threshold  the cash their drawer may hold; 0 = no limit
--       pickup_strict     1 = over the limit they cannot take more cash
--                         until a supervisor picks some up
--
-- A person with no row follows the organization's setting, as before.
-- Safe to re-run: the table is created only when missing.
-- =============================================================================

CREATE TABLE IF NOT EXISTS cashier_user_limits (
    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id  BIGINT UNSIGNED NOT NULL COMMENT 'Owning tenant organisation',
    user_id          BIGINT UNSIGNED NOT NULL COMMENT 'The person the limit is for',
    pickup_threshold DECIMAL(12,2)   NOT NULL DEFAULT 0.00 COMMENT 'Cash the drawer may hold before it should be handed in; 0 = no limit',
    pickup_strict    TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '1 = over the limit, no more cash payments until a pickup',
    updated_by       BIGINT UNSIGNED NULL,
    created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_cashier_user_limits (organization_id, user_id),
    KEY idx_cashier_user_limits_user (user_id),
    CONSTRAINT fk_cashier_user_limits_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_cashier_user_limits_user FOREIGN KEY (user_id)
        REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_cashier_user_limits_updated_by FOREIGN KEY (updated_by)
        REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT chk_cashier_user_limits_threshold CHECK (pickup_threshold >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='The cash limit of one person''s cashier (migration 043)';
