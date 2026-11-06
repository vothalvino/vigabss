-- =============================================================================
-- Migration 002 — reseller_admin loses the organization-wide security grants
-- =============================================================================
-- Development migration 335 gave reseller_admin "limited security visibility
-- for their org": the admin IP allowlist (view and create), firewall, DDoS,
-- blackhole and DNS-blocklist rules, CPE security scans, the password policy
-- and API key rate limits. Migration 471 later confined a reseller user to its
-- own reseller, but those routes are organization-wide and not reseller-scoped,
-- so a reseller partner could read the ISP's network defences and stage, or
-- activate, an admin IP allowlist entry that locks the ISP's own administrators
-- out of admin pages. Found on demo2 with a bound reseller user.
--
-- The group keeps its reseller_* grants (scoped by middleware/resellerScope.js)
-- and webauthn.* (a user's own passkeys). Safe to re-run: deleting grants that
-- are already gone changes nothing.
-- =============================================================================

DELETE rp
  FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id
  JOIN permissions p ON p.id = rp.permission_id
 WHERE r.name = 'reseller_admin'
   AND r.is_system = 1
   AND p.name IN (
     'admin_ip_allowlist.view',
     'admin_ip_allowlist.create',
     'api_key_rate_limits.view',
     'blackhole_routes.view',
     'cpe_security_scans.view',
     'ddos_protection.view',
     'dns_blocklists.view',
     'firewall_rules.view',
     'password_policy.view'
   );
