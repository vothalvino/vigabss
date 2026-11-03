-- =============================================================================
-- Rollback 517 — who wrote a ticket comment (FE-26)
-- =============================================================================
-- Roll back the application code with this. Client comments then show as
-- system messages again. Safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_517_ticket_comment_authorship;
DELIMITER //
CREATE PROCEDURE rollback_517_ticket_comment_authorship()
BEGIN
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ticket_comments'
                AND CONSTRAINT_NAME = 'fk_ticket_comments_client') THEN
    ALTER TABLE ticket_comments DROP FOREIGN KEY fk_ticket_comments_client;
  END IF;
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ticket_comments'
                AND INDEX_NAME = 'idx_ticket_comments_client_id') THEN
    ALTER TABLE ticket_comments DROP INDEX idx_ticket_comments_client_id;
  END IF;
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ticket_comments' AND COLUMN_NAME = 'client_id') THEN
    ALTER TABLE ticket_comments DROP COLUMN client_id;
  END IF;
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ticket_comments' AND COLUMN_NAME = 'author_type') THEN
    ALTER TABLE ticket_comments DROP COLUMN author_type;
  END IF;
END //
DELIMITER ;

CALL rollback_517_ticket_comment_authorship();
DROP PROCEDURE IF EXISTS rollback_517_ticket_comment_authorship;
