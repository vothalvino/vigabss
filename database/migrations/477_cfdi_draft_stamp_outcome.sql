-- =============================================================================
-- Migration 477 — record a draft CFDI's last failed stamp attempt
-- =============================================================================
-- CFD-02: a draft whose stamp was rejected could not be fixed from the UI.
-- Retries resent the stored XML (same Fecha, receptor and conceptos), drafts
-- could not be rebuilt or deleted, and the draft froze its invoice. Drafts can
-- now be discarded or rebuilt from the invoice, which is only safe when the
-- last attempt was definitely refused: a timeout may have been stamped by the
-- PAC after all. These columns keep the PAC's error for the draft and whether
-- the outcome was ambiguous (then the draft must be retried first; an
-- identical resubmission returns the existing stamp).
--
-- The guarded procedure makes the migration safe to resume after interrupted
-- MySQL DDL.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_477_cfdi_draft_stamp_outcome;
DELIMITER //
CREATE PROCEDURE migration_477_cfdi_draft_stamp_outcome()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND COLUMN_NAME = 'stamp_error'
  ) THEN
    ALTER TABLE cfdi_documents
      ADD COLUMN stamp_error TEXT NULL
        COMMENT 'Last failed stamp attempt: the PAC error shown on the draft (migration 477)'
        AFTER stamp_date;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND COLUMN_NAME = 'stamp_attempted_at'
  ) THEN
    ALTER TABLE cfdi_documents
      ADD COLUMN stamp_attempted_at DATETIME NULL
        COMMENT 'When the last failed stamp attempt ran (migration 477)'
        AFTER stamp_error;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND COLUMN_NAME = 'stamp_ambiguous'
  ) THEN
    ALTER TABLE cfdi_documents
      ADD COLUMN stamp_ambiguous TINYINT(1) NOT NULL DEFAULT 0
        COMMENT '1 = the last attempt timed out or got no definite answer, so it may be stamped; retry before discarding (migration 477)'
        AFTER stamp_attempted_at;
  END IF;
END //
DELIMITER ;

CALL migration_477_cfdi_draft_stamp_outcome();
DROP PROCEDURE IF EXISTS migration_477_cfdi_draft_stamp_outcome;
