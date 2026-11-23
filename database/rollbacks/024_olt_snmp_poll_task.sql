-- Rollback 024 — restores the earlier description and handler name of the
-- ftth_onu_optical_poll task. The earlier code does nothing when it runs.

UPDATE scheduled_tasks
   SET handler = 'services/ftth/onuOpticalPollHandler',
       description = 'Poll per-ONU optical diagnostics (Tx power, Rx power, temperature, voltage, bias current) and insert rows into onu_optical_metrics'
 WHERE task_name = 'ftth_onu_optical_poll'
   AND organization_id IS NULL
   AND handler = 'olt/oltSnmpPollService.pollAll';
