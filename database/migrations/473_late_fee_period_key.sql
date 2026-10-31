-- =============================================================================
-- Migration 473 — at most one late fee per rule, invoice and month
-- =============================================================================
-- ASY-02: the seeded install-wide apply_late_fees task used to match no
-- organization, so late fees never ran from the scheduler. It now runs for
-- every active organization. Before that happens, applications must be
-- bounded: a rule with max_applications NULL ("unlimited") was re-applied on
-- every run, i.e. a new fee every day, and a percent fee compounded on the
-- growing subtotal. Two scheduler replicas could also apply the same fee twice.
--
-- invoice_late_fees.period_key records the calendar month (UTC, 'YYYY-MM') an
-- application belongs to, and a UNIQUE key on (invoice, rule, period) makes a
-- second application in the same month impossible, whichever process tries.
-- Existing rows get a unique legacy key ('legacy-<id>') so the key can be
-- created over historical duplicates without rewriting them.
--
-- The guarded procedure makes the migration safe to resume after interrupted
-- MySQL DDL.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_473_late_fee_period_key;
DELIMITER //
CREATE PROCEDURE migration_473_late_fee_period_key()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'invoice_late_fees'
       AND COLUMN_NAME = 'period_key'
  ) THEN
    ALTER TABLE invoice_late_fees
      ADD COLUMN period_key VARCHAR(32) NULL DEFAULT NULL
        COMMENT 'Calendar month (UTC YYYY-MM) this application belongs to; legacy-<id> for rows before migration 473'
        AFTER invoice_item_id;
  END IF;

  UPDATE invoice_late_fees SET period_key = CONCAT('legacy-', id) WHERE period_key IS NULL;

  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'invoice_late_fees'
       AND COLUMN_NAME = 'period_key'
       AND IS_NULLABLE = 'YES'
  ) THEN
    ALTER TABLE invoice_late_fees
      MODIFY COLUMN period_key VARCHAR(32) NOT NULL
        COMMENT 'Calendar month (UTC YYYY-MM) this application belongs to; legacy-<id> for rows before migration 473';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'invoice_late_fees'
       AND INDEX_NAME = 'uq_invoice_late_fees_period'
  ) THEN
    ALTER TABLE invoice_late_fees
      ADD UNIQUE KEY uq_invoice_late_fees_period (invoice_id, late_fee_rule_id, period_key);
  END IF;
END //
DELIMITER ;

CALL migration_473_late_fee_period_key();
DROP PROCEDURE IF EXISTS migration_473_late_fee_period_key;
