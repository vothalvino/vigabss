-- =============================================================================
-- Rollback 467 — remove the TOTP replay guard column
-- =============================================================================
-- The code that reads users.totp_last_used_step must be rolled back first;
-- without the column a used TOTP code can be replayed inside its drift window.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_467_totp_replay_guard;
DELIMITER //
CREATE PROCEDURE rollback_467_totp_replay_guard()
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'totp_last_used_step'
  ) THEN
    ALTER TABLE users DROP COLUMN totp_last_used_step;
  END IF;
END //
DELIMITER ;

CALL rollback_467_totp_replay_guard();
DROP PROCEDURE IF EXISTS rollback_467_totp_replay_guard;
