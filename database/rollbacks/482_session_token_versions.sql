-- =============================================================================
-- Rollback 482 — drop the session token versions
-- =============================================================================
-- Access tokens are again valid until they expire after a password or account
-- change; roll back the application code with this.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_482_session_token_versions;
DELIMITER //
CREATE PROCEDURE rollback_482_session_token_versions()
BEGIN
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'token_version') THEN
    ALTER TABLE users DROP COLUMN token_version;
  END IF;
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clients' AND COLUMN_NAME = 'portal_token_version') THEN
    ALTER TABLE clients DROP COLUMN portal_token_version;
  END IF;
END //
DELIMITER ;

CALL rollback_482_session_token_versions();
DROP PROCEDURE IF EXISTS rollback_482_session_token_versions;
