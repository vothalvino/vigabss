-- =============================================================================
-- Migration 032 — a cashier's count is reviewed with a note; points have none
-- =============================================================================
-- A staff cashier whose count matches is approved when it is closed. One whose
-- count differs waits for a supervisor, who approves or disputes it and says
-- why:
--
--   review_note   the supervisor's note on a count that did not match
--
-- Resellers and collectors never open or close a cashier: their cash is
-- accounted for by their cash bags. The reseller app used to open a session
-- behind the scenes on the first collection and nothing ever closed it, so
-- those sessions sat on the staff page as open for ever. The ones still open
-- are retired here (soft-deleted); the ledger entries that name them keep
-- their reference.
--
-- Safe to re-run: the column is added only when missing, and retiring an
-- already retired session changes nothing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m032_cashier_review;
DELIMITER $$
CREATE PROCEDURE m032_cashier_review()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cash_reconciliation_sessions' AND COLUMN_NAME = 'review_note'
  ) THEN
    ALTER TABLE cash_reconciliation_sessions
      ADD COLUMN review_note TEXT NULL
        COMMENT 'The supervisor''s note when approving or disputing a count that did not match (migration 032)'
        AFTER approved_at;
  END IF;
END $$
DELIMITER ;
CALL m032_cashier_review();
DROP PROCEDURE IF EXISTS m032_cashier_review;

ALTER TABLE cash_reconciliation_sessions
  MODIFY COLUMN approved_by BIGINT UNSIGNED NULL
    COMMENT 'Supervisor who approved or disputed the session; NULL on an approved session = approved automatically because the count matched (migration 032)';

UPDATE cash_reconciliation_sessions
   SET deleted_at = NOW()
 WHERE status = 'open'
   AND deleted_at IS NULL
   AND notes = 'Opened by the reseller app';
