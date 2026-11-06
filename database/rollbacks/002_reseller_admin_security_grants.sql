-- Rollback 002 — restores reseller_admin's organization-wide security grants.
-- This reopens the hole migration 002 closed (a reseller user can read the
-- ISP's network security rules and stage admin IP allowlist entries); roll
-- back only to recover from a failed deploy, then roll forward.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN (
    'admin_ip_allowlist.view',
    'admin_ip_allowlist.create',
    'api_key_rate_limits.view',
    'blackhole_routes.view',
    'cpe_security_scans.view',
    'ddos_protection.view',
    'dns_blocklists.view',
    'firewall_rules.view',
    'password_policy.view'
  )
 WHERE r.name = 'reseller_admin'
   AND r.is_system = 1
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
   );
