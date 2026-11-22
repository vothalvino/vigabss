-- Rollback 014 — drops portal_chat_sessions.support_conversation_id. Chat
-- sessions lose the link to their support conversation; the conversations
-- themselves, their messages and any ticket they opened stay. The earlier
-- code answers every portal chat through a ticket and does not read the column.

DROP PROCEDURE IF EXISTS r014_portal_chat_conversation;
DELIMITER $$
CREATE PROCEDURE r014_portal_chat_conversation()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'portal_chat_sessions' AND COLUMN_NAME = 'support_conversation_id'
  ) THEN
    ALTER TABLE portal_chat_sessions
      DROP KEY idx_pcs_conversation,
      DROP COLUMN support_conversation_id;
  END IF;
END $$
DELIMITER ;
CALL r014_portal_chat_conversation();
DROP PROCEDURE IF EXISTS r014_portal_chat_conversation;
