-- =============================================================================
-- Migration 017 — the weekly VoIP range refresh is switched on in the app
-- =============================================================================
-- The scheduled task refresh_voip_ranges needed two things to run: its own
-- is_enabled flag, which the web GUI cannot change on an install-wide task,
-- and VOIP_RANGES_ENABLED=true in the server's environment. The environment
-- variable is gone; the flag is the one switch, and Network -> NAS has a
-- control for it (install operator). This only corrects the task's
-- description, which named the variable.
--
-- Safe to re-run: it rewrites the description only while it still names the
-- variable, and never touches is_enabled.
-- =============================================================================

UPDATE scheduled_tasks
   SET description = 'Refreshes the vigabss-voip RTC/VoIP address-list on managed MikroTik NAS from provider IP-range sources. Off by default; switch it on under Network > NAS once real-time priority is set up on a NAS.'
 WHERE task_name = 'refresh_voip_ranges'
   AND organization_id IS NULL
   AND description LIKE '%VOIP_RANGES_ENABLED%';
