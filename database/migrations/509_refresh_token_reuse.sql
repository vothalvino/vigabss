-- =============================================================================
-- Migration 509 — refresh-token reuse detection (SEC-23)
-- =============================================================================
-- Rotation deleted (staff) or revoked (portal) the old refresh token, so a
-- replayed copy looked like any unknown token and the session it was stolen
-- from stayed live. user_sessions.consumed_at keeps rotated staff rows until
-- they expire, and portal_refresh_tokens.rotated_at tells a rotated token from
-- one revoked by logout; presenting either ends the sessions it belongs to.
-- Re-runnable: both columns are guarded.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_509_refresh_token_reuse;
DELIMITER //
CREATE PROCEDURE migration_509_refresh_token_reuse()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_sessions' AND COLUMN_NAME = 'consumed_at'
  ) THEN
    ALTER TABLE user_sessions
      ADD COLUMN consumed_at TIMESTAMP NULL
        COMMENT 'Set when the refresh token was rotated; a replay revokes the family (migration 509)'
        AFTER last_active_at;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'portal_refresh_tokens' AND COLUMN_NAME = 'rotated_at'
  ) THEN
    ALTER TABLE portal_refresh_tokens
      ADD COLUMN rotated_at TIMESTAMP NULL
        COMMENT 'Set when the token was exchanged; a replay revokes every portal session (migration 509)'
        AFTER revoked_at;
  END IF;
END //
DELIMITER ;

CALL migration_509_refresh_token_reuse();
DROP PROCEDURE IF EXISTS migration_509_refresh_token_reuse;
