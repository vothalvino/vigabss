-- =============================================================================
-- Migration 487 — Require Message-Authenticator per NAS (NET-20)
-- =============================================================================
-- The embedded RADIUS server verified Message-Authenticator only when a request
-- carried one. An Access-Request without it cannot be authenticated, so a
-- flood with a registered NAS's spoofed source IP was processed in full, and
-- the server fell short of Blast-RADIUS hardening guidance.
--
-- nas.require_message_authenticator makes the server drop an Access-Request
-- without a valid Message-Authenticator. Existing NAS rows keep today's
-- behaviour (0) so a router that does not send it keeps working; new rows
-- default to 1.
--
-- The guarded procedure makes the migration safe to resume after interrupted
-- MySQL DDL.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_487_nas_require_message_authenticator;
DELIMITER //
CREATE PROCEDURE migration_487_nas_require_message_authenticator()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nas' AND COLUMN_NAME = 'require_message_authenticator'
  ) THEN
    ALTER TABLE nas
      ADD COLUMN require_message_authenticator BOOLEAN NOT NULL DEFAULT TRUE
        COMMENT 'Drop Access-Requests without a valid Message-Authenticator (Blast-RADIUS hardening; migration 487)'
        AFTER maintenance_mode;
    -- Rows that existed before this migration keep accepting requests without it.
    UPDATE nas SET require_message_authenticator = FALSE;
  END IF;
END //
DELIMITER ;

CALL migration_487_nas_require_message_authenticator();
DROP PROCEDURE IF EXISTS migration_487_nas_require_message_authenticator;
