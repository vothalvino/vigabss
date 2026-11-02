-- Rollback 506 — re-enable the deferred scheduled tasks (ASY-35). Safe to re-run.
UPDATE scheduled_tasks
   SET is_enabled = 1
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
