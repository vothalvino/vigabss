-- =============================================================================
-- Migration 475 — persist a soft suspension's throttle on the contract
-- =============================================================================
-- NPR-01: soft_suspend sent a bare CoA (User-Name only) and stored nothing,
-- yet the suspension log, API and console reported the subscriber as
-- throttled. A soft-suspended contract stays 'active', so the throttle has to
-- live somewhere RADIUS can read on every (re)authentication: these columns
-- hold the rate (kbps) while the soft suspension lasts. The FreeRADIUS sync
-- writes it as a per-user radreply override, the embedded server sends it in
-- the Access-Accept, and the speed-window CoA fan-out skips the contract.
-- Reconnecting clears both columns. NULL = not soft-suspended.
--
-- The guarded procedure makes the migration safe to resume after interrupted
-- MySQL DDL.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_475_contract_soft_suspend_throttle;
DELIMITER //
CREATE PROCEDURE migration_475_contract_soft_suspend_throttle()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'contracts'
       AND COLUMN_NAME = 'soft_suspend_download_kbps'
  ) THEN
    ALTER TABLE contracts
      ADD COLUMN soft_suspend_download_kbps INT UNSIGNED NULL DEFAULT NULL
        COMMENT 'Soft-suspension download throttle in kbps; NULL = not soft-suspended (migration 475)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'contracts'
       AND COLUMN_NAME = 'soft_suspend_upload_kbps'
  ) THEN
    ALTER TABLE contracts
      ADD COLUMN soft_suspend_upload_kbps INT UNSIGNED NULL DEFAULT NULL
        COMMENT 'Soft-suspension upload throttle in kbps; NULL = not soft-suspended (migration 475)';
  END IF;
END //
DELIMITER ;

CALL migration_475_contract_soft_suspend_throttle();
DROP PROCEDURE IF EXISTS migration_475_contract_soft_suspend_throttle;
