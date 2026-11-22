-- =============================================================================
-- Migration 015 — AI usage: speech to text
-- =============================================================================
-- The WhatsApp bot now transcribes voice notes with the organization's OpenAI
-- provider. Each transcription is recorded in ai_usage_events like a chat or
-- an embedding call, so it counts against the organization's AI budget:
-- ai_usage_events.operation gains 'transcribe'.
--
-- Safe to re-run: the ENUM is changed only while it lacks the value.
-- =============================================================================

DROP PROCEDURE IF EXISTS m015_ai_usage_transcribe;
DELIMITER $$
CREATE PROCEDURE m015_ai_usage_transcribe()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_usage_events' AND COLUMN_NAME = 'operation'
       AND COLUMN_TYPE NOT LIKE '%''transcribe''%'
  ) THEN
    ALTER TABLE ai_usage_events MODIFY COLUMN operation ENUM('chat','embed','transcribe') NOT NULL;
  END IF;
END $$
DELIMITER ;
CALL m015_ai_usage_transcribe();
DROP PROCEDURE IF EXISTS m015_ai_usage_transcribe;
