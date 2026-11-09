-- =============================================================================
-- Migration 010 — the Manager user group; logins for points of sale and
-- carriers; cash bags assigned to their point at handover
-- =============================================================================
-- 1. A system user group 'manager' (persona billing, so it never takes the
--    admin RBAC bypass): everything the admin group holds except
--    organization settings (settings, email and backup settings),
--    creating and editing staff users and their groups (users.create,
--    users.update, users.delete, roles), organizations, security
--    administration (IP allowlist, password policy, firewall, DDoS,
--    encryption, …; its own passkeys stay), integrations, API tokens,
--    webhooks, PAC providers, CSD certificates, payment gateways, data
--    residency, the AI provider and policy settings, the WireGuard admin
--    slugs and the compliance exports. It keeps users.view, so it can pick
--    staff for tickets and work orders. A later migration that gives admin a
--    new permission gives it to manager too unless it belongs to one of the
--    excluded areas (tests/managerRole.test.js checks every later
--    migration).
--
-- 2. point_logins.create (admin, manager): create the login of a reseller,
--    a collector or a carrier (POST /resellers/:id/users, POST /carriers)
--    without users.create. Those routes only ever create an account in
--    their fixed group, never a staff user of another group.
--
-- 3. Cash bags (no schema change): staff now hand bags to a carrier FOR a
--    point, so a with_carrier bag carries its reseller_id, appears on the
--    point's page at once and may be sealed there; the carrier's drop-off
--    only confirms the delivery (services/cashBagService.js). Bags already
--    with a carrier keep reseller_id NULL and may still be dropped off at
--    any point assigned to the carrier.
--
-- Safe to re-run: the seeds INSERT IGNORE.
-- =============================================================================

INSERT IGNORE INTO roles (name, description, kind, is_system) VALUES
  ('manager', 'Manager — runs the operation: everything an administrator does except organization settings, staff users and groups, security and integrations', 'billing', 1);

INSERT IGNORE INTO permissions (name, description, module) VALUES
  ('point_logins.create', 'Create the login of a reseller, a collector or a carrier (only in their own group, never a staff user)', 'point_logins');

-- admin holds every non-platform permission (seed invariant).
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('point_logins.create')
 WHERE r.name = 'admin'
   AND r.is_system = 1;

-- manager: what admin holds now, minus the excluded areas.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT m.id, rp.permission_id
  FROM roles m
  JOIN roles a ON a.name = 'admin' AND a.is_system = 1
  JOIN role_permissions rp ON rp.role_id = a.id
  JOIN permissions p ON p.id = rp.permission_id
 WHERE m.name = 'manager'
   AND m.is_system = 1
   AND (
     COALESCE(p.module, '') NOT IN (
       'settings', 'roles', 'organizations', 'security', 'integrations', 'api_tokens', 'webhooks',
       'pac_providers', 'csd_certificates', 'payment_gateways', 'data_residency'
     )
     OR p.name IN ('webauthn.view', 'webauthn.create', 'webauthn.delete')
   )
   AND p.name NOT IN (
     'users.create', 'users.update', 'users.delete',
     'ai.providers.read', 'ai.providers.write', 'ai.policy.write',
     'wireguard.peers.admin', 'wireguard.assignments.manage',
     'audit_export.view', 'report_access_logs.view'
   );
