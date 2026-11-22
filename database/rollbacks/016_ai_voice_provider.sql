-- Rollback 016 — drops ai_policies.voice_provider_id. Organizations lose their
-- choice of voice-note provider; the earlier code picks the first enabled
-- OpenAI or OpenRouter provider on its own.

DROP PROCEDURE IF EXISTS r016_ai_voice_provider;
DELIMITER $$
CREATE PROCEDURE r016_ai_voice_provider()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_policies' AND COLUMN_NAME = 'voice_provider_id'
  ) THEN
    ALTER TABLE ai_policies DROP COLUMN voice_provider_id;
  END IF;
END $$
DELIMITER ;
CALL r016_ai_voice_provider();
DROP PROCEDURE IF EXISTS r016_ai_voice_provider;
