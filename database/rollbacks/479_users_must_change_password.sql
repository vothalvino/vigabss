-- =============================================================================
-- Rollback 479 — drop the forced-password-change flag
-- =============================================================================
-- Accounts that had not yet changed their initial password are no longer
-- made to; roll back the application code with this.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_479_users_must_change_password;
DELIMITER //
CREATE PROCEDURE rollback_479_users_must_change_password()
BEGIN
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'must_change_password') THEN
    ALTER TABLE users DROP COLUMN must_change_password;
  END IF;
END //
DELIMITER ;

CALL rollback_479_users_must_change_password();
DROP PROCEDURE IF EXISTS rollback_479_users_must_change_password;
