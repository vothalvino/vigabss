-- =============================================================================
-- Migration 506 — disable seeded tasks whose handler is a deferred stub (ASY-35)
-- =============================================================================
-- These tasks were seeded enabled, but their taskRunner case only returns
-- { deferred: true }. Each tick took a scheduler slot and a lock session to do
-- nothing (seven of them were among the 20 tasks that deadlocked the pool at
-- one 5-minute mark), and the scheduled-tasks page showed them as healthy.
-- tests/scheduledTaskSeedContract.test.js keeps a deferred task from being
-- enabled again; enable a task in the migration that implements it.
-- Re-runnable: it only sets is_enabled.
-- =============================================================================

UPDATE scheduled_tasks
   SET is_enabled = 0
 WHERE organization_id IS NULL
   AND task_name IN (
     'check_fup_thresholds',
     'convert_expired_trials',
     'cpe_cwmp_task_processor',
     'cpe_firmware_campaign_processor',
     'ftth_olt_port_metrics_poll',
     'ftth_onu_discovery',
     'ftth_onu_firmware_job_processor',
     'ftth_onu_optical_poll',
     'fup_threshold_notify',
     'subscriber_speed_test_run'
   );
