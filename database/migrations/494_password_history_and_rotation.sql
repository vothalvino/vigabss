-- =============================================================================
-- Migration 494 — password history and the time a password was set (SEC-17)
-- =============================================================================
-- password_policies.history_count and rotation_days were stored but nothing
-- could enforce them: no record of earlier passwords existed, and nothing
-- said when the current one was set.
--   users.password_changed_at  — rotation_days counts from here. Existing rows
--                                start at the migration time.
--   password_history           — bcrypt hashes of replaced passwords (the last
--                                24 per user), compared on change and reset.
-- The guarded procedure makes the migration safe to resume after interrupted
-- MySQL DDL.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_494_password_history_and_rotation;
DELIMITER //
CREATE PROCEDURE migration_494_password_history_and_rotation()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password_changed_at'
  ) THEN
    ALTER TABLE users
      ADD COLUMN password_changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        COMMENT 'When the current password was set; password_policies.rotation_days counts from here (migration 494)'
        AFTER must_change_password;
  END IF;
END //
DELIMITER ;

CALL migration_494_password_history_and_rotation();
DROP PROCEDURE IF EXISTS migration_494_password_history_and_rotation;

CREATE TABLE IF NOT EXISTS password_history (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id         BIGINT UNSIGNED NOT NULL,
    password_hash   VARCHAR(255)    NOT NULL COMMENT 'bcrypt hash of a replaced password; never a plaintext',
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_password_history_user (user_id, id),
    CONSTRAINT fk_password_history_user FOREIGN KEY (user_id)
        REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Replaced password hashes per user for password_policies.history_count (migration 494)';
