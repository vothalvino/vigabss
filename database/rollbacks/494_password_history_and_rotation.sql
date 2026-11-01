-- =============================================================================
-- Rollback 494 — drop password history and password_changed_at
-- =============================================================================
-- history_count and rotation_days stop being enforceable; roll back the
-- application code with this.
-- =============================================================================

DROP TABLE IF EXISTS password_history;

DROP PROCEDURE IF EXISTS rollback_494_password_history_and_rotation;
DELIMITER //
CREATE PROCEDURE rollback_494_password_history_and_rotation()
BEGIN
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password_changed_at') THEN
    ALTER TABLE users DROP COLUMN password_changed_at;
  END IF;
END //
DELIMITER ;

CALL rollback_494_password_history_and_rotation();
DROP PROCEDURE IF EXISTS rollback_494_password_history_and_rotation;
