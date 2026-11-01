-- =============================================================================
-- Migration 481 — a write permission for wireless client-session ingest
-- =============================================================================
-- POST /wireless/clients/batch inserts wireless_client_sessions rows, yet it
-- was guarded by the read slug wireless_clients.view, which technician and
-- readonly hold (migration 281). wireless_clients.ingest is the write slug for
-- that endpoint: admin and noc_operator get it, and a poller's API token is
-- given it as a scope (TNB-21).
-- =============================================================================

INSERT IGNORE INTO permissions (name, description, module)
VALUES (
  'wireless_clients.ingest',
  'Record wireless client session snapshots (poller ingest)',
  'wireless'
);

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   roles r
JOIN   permissions p ON p.name = 'wireless_clients.ingest'
WHERE  r.name IN ('admin', 'noc_operator');
