-- =============================================================================
-- Migration 483 — built-in grants that match what each persona is shown (DB-23)
-- =============================================================================
-- A replay of every migration showed the built-in groups out of step with the
-- routes:
--   * technician holds tickets.view but not tickets.update, and POST
--     /tickets/:id/comments required tickets.update, so the comment form the
--     technician is shown always 403'd. tickets.comment is a narrow slug for
--     posting a comment; the route accepts it or tickets.update. Every group
--     that can already update tickets keeps commenting through tickets.comment
--     too.
--   * technician lacked cpe_diagnostics.view and provisioning_pipelines.view,
--     which readonly has.
--   * readonly holds nas.health, which also guarded POST /nas/:id/health-check
--     — a fleet-wide probe that writes nas.health_status. The probe now needs
--     nas.health_check (admin, technician, noc_operator); nas.health stays the
--     read slug.
-- =============================================================================

INSERT IGNORE INTO permissions (name, description, module) VALUES
  ('tickets.comment',  'Post a comment on a ticket',                       'tickets'),
  ('nas.health_check', 'Run a NAS health-check probe (writes health status)', 'nas');

-- tickets.comment: technician, plus every group that holds tickets.update.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   roles r
JOIN   permissions p ON p.name = 'tickets.comment'
WHERE  r.name = 'technician';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, pc.id
FROM   role_permissions rp
JOIN   permissions pu ON pu.id = rp.permission_id AND pu.name = 'tickets.update'
JOIN   permissions pc ON pc.name = 'tickets.comment';

-- technician: read CPE diagnostics and provisioning pipelines.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   roles r
JOIN   permissions p ON p.name IN ('cpe_diagnostics.view', 'provisioning_pipelines.view')
WHERE  r.name = 'technician';

-- nas.health_check: the groups that operate the network.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   roles r
JOIN   permissions p ON p.name = 'nas.health_check'
WHERE  r.name IN ('admin', 'super_admin', 'technician', 'noc_operator');
