-- =============================================================================
-- Rollback 483 — remove the persona grant fixes
-- =============================================================================
-- Roll back the application code with this: the comment and health-check
-- routes would otherwise require slugs that no longer exist. The technician
-- grants of cpe_diagnostics.view and provisioning_pipelines.view are removed
-- too.
-- =============================================================================

DELETE rp FROM role_permissions rp
JOIN permissions p ON p.id = rp.permission_id
WHERE p.name IN ('tickets.comment', 'nas.health_check');

DELETE FROM permissions WHERE name IN ('tickets.comment', 'nas.health_check');

DELETE rp FROM role_permissions rp
JOIN permissions p ON p.id = rp.permission_id
JOIN roles r ON r.id = rp.role_id
WHERE r.name = 'technician' AND p.name IN ('cpe_diagnostics.view', 'provisioning_pipelines.view');
