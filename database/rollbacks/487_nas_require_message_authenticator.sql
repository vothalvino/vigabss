-- =============================================================================
-- Rollback 487 — drop nas.require_message_authenticator
-- =============================================================================
-- Access-Requests without Message-Authenticator are accepted again from every
-- NAS. Roll back the application code with this.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_487_nas_require_message_authenticator;
DELIMITER //
CREATE PROCEDURE rollback_487_nas_require_message_authenticator()
BEGIN
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nas' AND COLUMN_NAME = 'require_message_authenticator') THEN
    ALTER TABLE nas DROP COLUMN require_message_authenticator;
  END IF;
END //
DELIMITER ;

CALL rollback_487_nas_require_message_authenticator();
DROP PROCEDURE IF EXISTS rollback_487_nas_require_message_authenticator;
