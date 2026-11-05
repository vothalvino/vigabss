-- =============================================================================
-- Migration 520 — Per-organization credit note number sequence
-- =============================================================================
-- credit_notes.credit_note_number is NOT NULL with no default, and the staff
-- form leaves it blank to have one generated, but nothing generated it: the
-- create failed with a 500. billingService.nextCreditNoteNumber() draws
-- NC-###### numbers from this counter on the insert's own transaction, as
-- organization_quote_sequences (migration 389) does for quotes. Sentinel
-- organization_id 0 is the NULL-organization bucket.
-- =============================================================================

CREATE TABLE IF NOT EXISTS organization_credit_note_sequences (
    organization_id BIGINT UNSIGNED NOT NULL COMMENT 'Owning tenant organisation; sentinel 0 = the NULL/single-tenant-deployment bucket',
    next_number     BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Next NC-###### sequence value to hand out; advanced atomically by billingService.nextCreditNoteNumber()',
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (organization_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Atomic per-organization credit note number counter (migration 520)';
