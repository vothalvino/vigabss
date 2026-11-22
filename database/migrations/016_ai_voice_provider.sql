-- =============================================================================
-- Migration 016 — the provider that transcribes voice notes is chosen
-- =============================================================================
-- WhatsApp voice notes were transcribed by "the first enabled OpenAI or
-- OpenRouter provider", which nobody could see or choose. An organization now
-- names the provider (AI Support → Settings → Providers → "Voice notes"):
-- ai_policies.voice_provider_id. NULL keeps the automatic choice, so nothing
-- changes for an organization that never sets it.
--
-- Safe to re-run: the column is added only when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m016_ai_voice_provider;
DELIMITER $$
CREATE PROCEDURE m016_ai_voice_provider()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_policies' AND COLUMN_NAME = 'voice_provider_id'
  ) THEN
    ALTER TABLE ai_policies
      ADD COLUMN voice_provider_id BIGINT UNSIGNED NULL
        COMMENT 'ai_providers.id that transcribes voice notes; NULL = first enabled OpenAI/OpenRouter provider (migration 016)'
        AFTER active_provider_id;
  END IF;
END $$
DELIMITER ;
CALL m016_ai_voice_provider();
DROP PROCEDURE IF EXISTS m016_ai_voice_provider;
