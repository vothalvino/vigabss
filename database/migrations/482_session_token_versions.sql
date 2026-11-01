-- =============================================================================
-- Migration 482 — token versions that revoke outstanding access tokens
-- =============================================================================
-- Access JWTs were checked only for signature and expiry, so after an admin
-- reset a user's password, changed their email, status or group, or archived
-- them, every access token already issued kept working until it expired (60
-- minutes by default); the portal had the same gap after a password change.
-- Each account now carries a version that is embedded in its access tokens
-- and compared on every request. Revoking an account's sessions bumps it
-- (SEC-10).
--
-- The guarded procedure makes the migration safe to resume after interrupted
-- MySQL DDL.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_482_session_token_versions;
DELIMITER //
CREATE PROCEDURE migration_482_session_token_versions()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'token_version'
  ) THEN
    ALTER TABLE users
      ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 0
        COMMENT 'Embedded in access JWTs; bumped to revoke every outstanding access token (migration 482)'
        AFTER must_change_password;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clients' AND COLUMN_NAME = 'portal_token_version'
  ) THEN
    ALTER TABLE clients
      ADD COLUMN portal_token_version INT UNSIGNED NOT NULL DEFAULT 0
        COMMENT 'Embedded in portal access JWTs; bumped to revoke every outstanding portal session (migration 482)'
        AFTER portal_reset_token_expires;
  END IF;
END //
DELIMITER ;

CALL migration_482_session_token_versions();
DROP PROCEDURE IF EXISTS migration_482_session_token_versions;
