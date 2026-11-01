-- =============================================================================
-- Migration 493 — pppoe.events_ingest becomes pppoe_events.ingest
-- =============================================================================
-- Migration 240 seeded pppoe.events_ingest, but no route ever checked it. The
-- new org-bound POST /pppoe/events/tenant checks it now, and an API token's
-- scope is derived from the slug: "pppoe.events_ingest" maps to the broad
-- pppoe:write, while "pppoe_events.ingest" maps to the collector-only
-- pppoe_events:ingest scope, like connection_logs.ingest (WHK-09).
-- Every role that held the old slug gets the new one; the old slug is then
-- removed (role_permissions rows cascade). Safe to re-run.
-- =============================================================================

INSERT IGNORE INTO permissions (name, description, module) VALUES
  ('pppoe_events.ingest', 'Collector-only POST /pppoe/events/tenant for one organization''s PPPoE events', 'pppoe');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, np.id
FROM   role_permissions rp
JOIN   permissions op ON op.id = rp.permission_id AND op.name = 'pppoe.events_ingest'
JOIN   permissions np ON np.name = 'pppoe_events.ingest';

DELETE FROM permissions WHERE name = 'pppoe.events_ingest';
