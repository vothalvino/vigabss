-- =============================================================================
-- Migration 523 — A firmware download is done when it is installed
-- =============================================================================
-- A TR-069 Download task was 'done' as soon as the CPE answered the Download
-- RPC, which only says it accepted (Status 1: it will apply the image later)
-- or applied it. Firmware campaigns counted those as upgraded CPEs, though
-- the transfer could still fail and nobody checked the version the CPE ran
-- afterwards. 'awaiting_transfer' holds a download until the CPE's
-- TransferComplete (or, for Status 0, its next Inform) confirms it, and the
-- version it reports is the campaign's.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_523_cpe_task_awaiting_transfer;
DELIMITER //
CREATE PROCEDURE migration_523_cpe_task_awaiting_transfer()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cpe_tasks'
       AND COLUMN_NAME = 'status' AND COLUMN_TYPE LIKE '%''awaiting_transfer''%'
  ) THEN
    ALTER TABLE cpe_tasks
      MODIFY COLUMN status ENUM('queued','in_progress','awaiting_transfer','done','failed') NOT NULL DEFAULT 'queued';
  END IF;
END //
DELIMITER ;

CALL migration_523_cpe_task_awaiting_transfer();
DROP PROCEDURE IF EXISTS migration_523_cpe_task_awaiting_transfer;
