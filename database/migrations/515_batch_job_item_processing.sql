-- =============================================================================
-- Migration 515 — batch job items claimed before they run (TNA-41)
-- =============================================================================
-- Batch jobs ran inside the HTTP request and outlived its 30-second timeout.
-- They now run in the background from persisted items. An item is marked
-- 'processing' before its operation runs, so a job resumed after a restart
-- can tell an item that may already have been applied (left 'processing',
-- recorded as a failure to check by hand) from one never started ('pending').
-- Re-runnable: the change is skipped once the column has the new value.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_515_batch_item_processing;
DELIMITER //
CREATE PROCEDURE migration_515_batch_item_processing()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'batch_job_items'
       AND COLUMN_NAME = 'status' AND COLUMN_TYPE LIKE '%''processing''%'
  ) THEN
    ALTER TABLE batch_job_items
      MODIFY COLUMN status ENUM('pending','processing','success','failure','skipped') NOT NULL DEFAULT 'pending'
        COMMENT 'processing = claimed, outcome not yet recorded (migration 515)';
  END IF;
END //
DELIMITER ;

CALL migration_515_batch_item_processing();
DROP PROCEDURE IF EXISTS migration_515_batch_item_processing;
