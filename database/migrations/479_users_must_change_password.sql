-- =============================================================================
-- Migration 479 — force a password change at first login
-- =============================================================================
-- The installer creates the first administrator with a generated password it
-- prints on the console (OPS-03). Nothing made the operator replace it, so a
-- password that sat in a terminal scrollback (and, before OPS-03, in
-- .env.prod) stayed valid indefinitely. Accounts flagged here can only view
-- their own profile, change their password, or log out until they do.
--
-- The guarded procedure makes the migration safe to resume after interrupted
-- MySQL DDL.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_479_users_must_change_password;
DELIMITER //
CREATE PROCEDURE migration_479_users_must_change_password()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'must_change_password'
  ) THEN
    ALTER TABLE users
      ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0
        COMMENT '1 = the account must set a new password before doing anything else; set for the installer-created administrator (migration 479)'
        AFTER is_install_operator;
  END IF;
END //
DELIMITER ;

CALL migration_479_users_must_change_password();
DROP PROCEDURE IF EXISTS migration_479_users_must_change_password;
