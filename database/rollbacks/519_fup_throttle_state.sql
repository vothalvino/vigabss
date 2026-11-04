-- =============================================================================
-- Rollback 519 — FUP throttle state; FUP tasks enabled; trial conversion retired (ASY-36)
-- =============================================================================
-- Roll back the application code with this. The FUP tasks go back to
-- disabled (migration 506) and convert_expired_trials is re-seeded disabled.
-- Contracts throttled by FUP get the plan rate at their next authentication.
-- Safe to re-run.
-- =============================================================================

UPDATE scheduled_tasks
   SET is_enabled = 0
 WHERE organization_id IS NULL
   AND task_name IN ('check_fup_thresholds', 'fup_threshold_notify');

INSERT INTO scheduled_tasks (organization_id, task_name, description, cron_expression, is_enabled, priority)
SELECT NULL, 'convert_expired_trials', 'Convert expired free-trial contracts to paid billing and notify the client', '0 * * * *', FALSE, 'normal'
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM scheduled_tasks
    WHERE task_name = 'convert_expired_trials' AND organization_id IS NULL
);

DROP PROCEDURE IF EXISTS rollback_519_fup_throttle_state;
DELIMITER //
CREATE PROCEDURE rollback_519_fup_throttle_state()
BEGIN
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contracts' AND COLUMN_NAME = 'fup_throttled_month') THEN
    ALTER TABLE contracts DROP COLUMN fup_throttled_month;
  END IF;
END //
DELIMITER ;

CALL rollback_519_fup_throttle_state();
DROP PROCEDURE IF EXISTS rollback_519_fup_throttle_state;
