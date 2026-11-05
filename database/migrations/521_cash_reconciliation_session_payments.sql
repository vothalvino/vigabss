-- =============================================================================
-- Migration 521 — Freeze a cash session's payments when it closes
-- =============================================================================
-- Closing a session stored only expected_total; the session detail re-read
-- the agent's cash payments from the time window on every request. A payment
-- deleted, refunded or re-dated after the close dropped out of the list (or
-- one recorded late with an earlier created_at joined it) while the stored
-- total stayed, so a closed or approved session no longer added up.
-- cashReconciliationService.closeSession writes the payments it summed here,
-- in the close's transaction, and the detail of a closed session reads them.
-- =============================================================================

CREATE TABLE IF NOT EXISTS cash_reconciliation_session_payments (
    session_id      BIGINT UNSIGNED NOT NULL COMMENT 'The closed session',
    payment_id      BIGINT UNSIGNED NOT NULL COMMENT 'A cash payment counted in its expected_total',
    organization_id BIGINT UNSIGNED NULL     COMMENT 'Owning tenant organisation (the session''s)',
    amount          DECIMAL(12,2)   NOT NULL COMMENT 'The payment amount as summed at close',
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (session_id, payment_id),
    KEY idx_cash_recon_payments_payment (payment_id),
    KEY idx_cash_recon_payments_org (organization_id),
    CONSTRAINT fk_cash_recon_payments_session FOREIGN KEY (session_id)
        REFERENCES cash_reconciliation_sessions (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_cash_recon_payments_payment FOREIGN KEY (payment_id)
        REFERENCES payments (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_cash_recon_payments_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='The payments a closed cash reconciliation session counted (migration 521)';
