-- =============================================================================
-- Migration 014 — the portal chat keeps its support conversation
-- =============================================================================
-- With the AI assistant set to answer on the portal by itself, the portal chat
-- is now answered by the support conversation engine (the one behind the
-- WhatsApp bot and the Conversations tab): it reads the customer's account
-- and connection and answers in a few sentences, and opens a ticket only when
-- it hands the chat to staff. portal_chat_sessions.support_conversation_id
-- ties a chat session to that conversation so follow-up messages continue it.
-- NULL for sessions answered the earlier way (a ticket per session).
--
-- Safe to re-run: the column and its index are added only when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m014_portal_chat_conversation;
DELIMITER $$
CREATE PROCEDURE m014_portal_chat_conversation()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'portal_chat_sessions' AND COLUMN_NAME = 'support_conversation_id'
  ) THEN
    ALTER TABLE portal_chat_sessions
      ADD COLUMN support_conversation_id BIGINT UNSIGNED NULL
        COMMENT 'support_conversations.id answering this chat; NULL = ticket-per-session (migration 014)' AFTER ticket_id,
      ADD KEY idx_pcs_conversation (support_conversation_id);
  END IF;
END $$
DELIMITER ;
CALL m014_portal_chat_conversation();
DROP PROCEDURE IF EXISTS m014_portal_chat_conversation;
