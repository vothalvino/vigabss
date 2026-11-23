-- Rollback 017 — restores the earlier description of the refresh_voip_ranges
-- task. The earlier code also needs VOIP_RANGES_ENABLED=true in the
-- environment before the task does anything.

UPDATE scheduled_tasks
   SET description = 'Refreshes the vigabss-voip RTC/VoIP address-list on managed MikroTik NAS from provider IP-range sources. Disabled by default; enable once real-time priority is seeded and VOIP_RANGES_ENABLED=true.'
 WHERE task_name = 'refresh_voip_ranges'
   AND organization_id IS NULL
   AND description LIKE '%switch it on under Network > NAS%';
