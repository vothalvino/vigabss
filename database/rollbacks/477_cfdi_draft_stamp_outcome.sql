-- =============================================================================
-- Rollback 477 — drop the draft CFDI stamp-outcome columns
-- =============================================================================
-- Drafts lose their stored stamp error and the ambiguous-attempt marker; the
-- discard/rebuild actions then cannot tell a refused draft from one that may
-- have been stamped, so roll back the application code with this.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_477_cfdi_draft_stamp_outcome;
DELIMITER //
CREATE PROCEDURE rollback_477_cfdi_draft_stamp_outcome()
BEGIN
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND COLUMN_NAME = 'stamp_ambiguous') THEN
    ALTER TABLE cfdi_documents DROP COLUMN stamp_ambiguous;
  END IF;
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND COLUMN_NAME = 'stamp_attempted_at') THEN
    ALTER TABLE cfdi_documents DROP COLUMN stamp_attempted_at;
  END IF;
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfdi_documents' AND COLUMN_NAME = 'stamp_error') THEN
    ALTER TABLE cfdi_documents DROP COLUMN stamp_error;
  END IF;
END //
DELIMITER ;

CALL rollback_477_cfdi_draft_stamp_outcome();
DROP PROCEDURE IF EXISTS rollback_477_cfdi_draft_stamp_outcome;
