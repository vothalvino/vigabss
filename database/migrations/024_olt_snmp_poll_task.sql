-- =============================================================================
-- Migration 024 — the scheduled OLT read is described as what it does
-- =============================================================================
-- The task ftth_onu_optical_poll now reads every OLT over SNMP and remembers
-- each ONU's state, distance and signal per PON port (olt_onu_readings). Its
-- description and handler named a placeholder. It is switched on in the app
-- (Network > OLT Management > Live OLT); this does not touch is_enabled.
--
-- Safe to re-run: it rewrites the row only while it still names the placeholder.
-- =============================================================================

UPDATE scheduled_tasks
   SET handler = 'olt/oltSnmpPollService.pollAll',
       description = 'Reads every OLT over SNMP and remembers each ONU''s state, distance and signal per PON port, for the fibre check. Off by default; switch it on under Network > OLT Management > Live OLT.'
 WHERE task_name = 'ftth_onu_optical_poll'
   AND organization_id IS NULL
   AND handler = 'services/ftth/onuOpticalPollHandler';
