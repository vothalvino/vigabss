-- =============================================================================
-- Migration 517 — who wrote a ticket comment (FE-26)
-- =============================================================================
-- A comment from the portal was stored with user_id NULL, the same as a
-- system message, so staff saw a client's reply as written by "System".
-- author_type records staff, client or system, and client_id the client who
-- wrote it. Existing rows with a user are staff comments. Re-runnable: each
-- step is skipped once applied.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_517_ticket_comment_authorship;
DELIMITER //
CREATE PROCEDURE migration_517_ticket_comment_authorship()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ticket_comments' AND COLUMN_NAME = 'author_type'
  ) THEN
    ALTER TABLE ticket_comments
      ADD COLUMN author_type ENUM('staff','client','system') NOT NULL DEFAULT 'system'
        COMMENT 'Who wrote it: staff (user_id), client (client_id) or system (migration 517)' AFTER user_id,
      ADD COLUMN client_id BIGINT UNSIGNED NULL
        COMMENT 'Client who wrote it from the portal or chat (migration 517)' AFTER author_type;
    UPDATE ticket_comments SET author_type = 'staff' WHERE user_id IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ticket_comments' AND INDEX_NAME = 'idx_ticket_comments_client_id'
  ) THEN
    ALTER TABLE ticket_comments ADD KEY idx_ticket_comments_client_id (client_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ticket_comments'
       AND CONSTRAINT_NAME = 'fk_ticket_comments_client' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE ticket_comments
      ADD CONSTRAINT fk_ticket_comments_client FOREIGN KEY (client_id)
        REFERENCES clients (id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END //
DELIMITER ;

CALL migration_517_ticket_comment_authorship();
DROP PROCEDURE IF EXISTS migration_517_ticket_comment_authorship;
