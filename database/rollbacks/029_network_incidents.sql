-- Rollback 029 — drops network incidents, their samples and reports, the kept
-- connection checks and the task that watches the tree. The history of
-- incidents, closing comments and evidence is lost.

DELETE FROM scheduled_tasks WHERE task_name = 'network_health_watch';
DROP TABLE IF EXISTS network_incident_reports;
DROP TABLE IF EXISTS connection_checks;
DROP TABLE IF EXISTS network_incident_samples;
DROP TABLE IF EXISTS network_incidents;
