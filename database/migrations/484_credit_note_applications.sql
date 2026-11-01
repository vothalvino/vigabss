-- =============================================================================
-- Migration 484: Credit-note applications (audit BIL-14)
-- =============================================================================
-- A credit note raised against an invoice only posted a ledger credit; nothing
-- reduced the invoice. Its balance_due stayed total minus payment allocations,
-- so autopay, the portal Pay button, late fees and suspension all still acted
-- on the full amount after staff credited it, and no code ever set a note to
-- 'applied'.
--
-- One live row per note records how much of it is applied to the invoice it
-- credits. Every open-balance calculation subtracts the live applications next
-- to the payment allocations, and the client balance counts only the
-- unapplied part of a note as standing credit.
--
-- CREATE TABLE IF NOT EXISTS keeps the migration safely re-runnable.
-- =============================================================================

CREATE TABLE IF NOT EXISTS credit_note_applications (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    credit_note_id  BIGINT UNSIGNED NOT NULL COMMENT 'Credit note being applied',
    invoice_id      BIGINT UNSIGNED NOT NULL COMMENT 'Invoice the note credits',
    amount          DECIMAL(10, 2)  NOT NULL COMMENT 'Portion of the note applied to the invoice',
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at      DATETIME        DEFAULT NULL COMMENT 'Released (note cancelled, deleted or re-synced, invoice voided)',
    active_flag     TINYINT(1) GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) STORED
                        COMMENT 'NULL when released; keeps one live application per note',
    PRIMARY KEY (id),
    UNIQUE KEY uq_credit_note_applications_note (credit_note_id, active_flag),
    KEY idx_credit_note_applications_invoice (invoice_id),
    CONSTRAINT fk_credit_note_applications_note FOREIGN KEY (credit_note_id)
        REFERENCES credit_notes (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_credit_note_applications_invoice FOREIGN KEY (invoice_id)
        REFERENCES invoices (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='How much of a credit note is applied to the invoice it credits (BIL-14)';
