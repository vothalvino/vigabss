-- =============================================================================
-- Rollback 493: restore the pppoe.events_ingest permission name
-- =============================================================================

INSERT IGNORE INTO permissions (name, description, module) VALUES
  ('pppoe.events_ingest', 'Machine-to-machine POST /pppoe/events for syslog ingest', 'pppoe');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, op.id
FROM   role_permissions rp
JOIN   permissions np ON np.id = rp.permission_id AND np.name = 'pppoe_events.ingest'
JOIN   permissions op ON op.name = 'pppoe.events_ingest';

DELETE FROM permissions WHERE name = 'pppoe_events.ingest';
