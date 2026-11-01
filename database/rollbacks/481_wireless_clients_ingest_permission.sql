-- =============================================================================
-- Rollback 481 — remove the wireless client-session ingest permission
-- =============================================================================
-- Roll back the application code with this: the batch route would otherwise
-- require a slug nobody holds.
-- =============================================================================

DELETE rp FROM role_permissions rp
JOIN permissions p ON p.id = rp.permission_id
WHERE p.name = 'wireless_clients.ingest';

DELETE FROM permissions WHERE name = 'wireless_clients.ingest';
