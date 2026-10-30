-- =============================================================================
-- Migration 467 — single-use TOTP codes
-- =============================================================================
-- Staff login now enforces TOTP two-factor authentication (POST /auth/login
-- returns a challenge; POST /auth/login/2fa completes it). A TOTP code is valid
-- for a +/-1 step drift window, so without state the same six digits could be
-- replayed for up to ~90 seconds by anyone who observed them.
--
-- users.totp_last_used_step records the most recent accepted RFC 6238 time
-- step. twoFactorService.verifyCode() only accepts a strictly later step and
-- advances it with a conditional UPDATE, so concurrent replays cannot both
-- succeed. NULL (every existing row) means "no code used yet".
--
-- The guarded procedure makes the migration safe to resume after interrupted
-- MySQL DDL.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_467_totp_replay_guard;
DELIMITER //
CREATE PROCEDURE migration_467_totp_replay_guard()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'totp_last_used_step'
  ) THEN
    ALTER TABLE users
      ADD COLUMN totp_last_used_step BIGINT UNSIGNED NULL DEFAULT NULL
        COMMENT 'Last accepted TOTP time step (unix time / 30); a code is accepted only for a later step (migration 467)'
        AFTER totp_backup_codes;
  END IF;
END //
DELIMITER ;

CALL migration_467_totp_replay_guard();
DROP PROCEDURE IF EXISTS migration_467_totp_replay_guard;
