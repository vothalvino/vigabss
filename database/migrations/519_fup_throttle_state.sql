-- =============================================================================
-- Migration 519 — FUP throttle state; FUP tasks enabled; trial conversion retired (ASY-36)
-- =============================================================================
-- check_fup_thresholds was a deferred stub because applyFupThrottle had no
-- idempotency guard and sent a CoA with no rate attributes: a */15 cron would
-- have re-throttled every over-cap contract every tick, and nothing kept the
-- throttle across a reconnect. contracts.fup_throttled_month records the
-- billing month a contract is throttled for. The task sets it once per month
-- (a conditional UPDATE), RADIUS serves the plan's FUP rate while it names
-- the current month, and the task restores the plan rate when the month ends
-- or a data pack lifts the contract back under its threshold.
--
-- fup_threshold_notify now sweeps every organization.
--
-- convert_expired_trials is removed: invoices already price the trial window
-- (billingService.isContractInTrial, BIL-13), and a contract has no trial
-- status to convert, so the task had nothing to do.
-- Re-runnable: the column is added once; the task rows are set idempotently.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_519_fup_throttle_state;
DELIMITER //
CREATE PROCEDURE migration_519_fup_throttle_state()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contracts'
       AND COLUMN_NAME = 'fup_throttled_month'
  ) THEN
    ALTER TABLE contracts
      ADD COLUMN fup_throttled_month DATE NULL DEFAULT NULL
        COMMENT 'First day of the billing month whose FUP throttle applies; NULL or an earlier month = not throttled (migration 519)'
        AFTER soft_suspend_upload_kbps;
  END IF;
END //
DELIMITER ;

CALL migration_519_fup_throttle_state();
DROP PROCEDURE IF EXISTS migration_519_fup_throttle_state;

UPDATE scheduled_tasks
   SET is_enabled = 1
 WHERE organization_id IS NULL
   AND task_name IN ('check_fup_thresholds', 'fup_threshold_notify');

DELETE FROM scheduled_tasks
 WHERE task_name = 'convert_expired_trials';
