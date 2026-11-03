-- =============================================================================
-- Rollback 509 — refresh-token reuse detection (SEC-23)
-- =============================================================================
-- Roll back the application code with this. Safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_509_refresh_token_reuse;
DELIMITER //
CREATE PROCEDURE rollback_509_refresh_token_reuse()
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_sessions' AND COLUMN_NAME = 'consumed_at'
  ) THEN
    DELETE FROM user_sessions WHERE consumed_at IS NOT NULL;
    ALTER TABLE user_sessions DROP COLUMN consumed_at;
  END IF;
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'portal_refresh_tokens' AND COLUMN_NAME = 'rotated_at'
  ) THEN
    ALTER TABLE portal_refresh_tokens DROP COLUMN rotated_at;
  END IF;
END //
DELIMITER ;

CALL rollback_509_refresh_token_reuse();
DROP PROCEDURE IF EXISTS rollback_509_refresh_token_reuse;
