// =============================================================================
// reseller_admin holds only reseller-scoped grants and its own passkeys
// =============================================================================
// Migration 335 (pre-release history, now in the baseline) granted the group
// organization-wide security views and admin_ip_allowlist.create. A reseller
// user is confined to its reseller (middleware/resellerScope.js), but those
// routes are not reseller-scoped: on a test install a bound reseller user read the
// firewall/DDoS/blocklist rules and staged an admin IP allowlist entry, which,
// activated, locks the ISP's administrators out. Migration 002 revokes them.
// This replays the baseline grants and every later migration's revocations.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { baselineRows } = require('./helpers/baseline');

const MIGRATIONS = path.join(__dirname, '..', 'database', 'migrations');

// Grants a reseller user may hold: routes scoped by resellerScope, plus the
// caller's own passkeys.
const ALLOWED = /^(?:(?:reseller_[a-z_]+|webauthn)\.[a-z_]+|resellers\.view)$/;

function revokedByLaterMigrations() {
  const revoked = new Set();
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f) && !f.startsWith('001_'))) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8').replace(/--.*$/gm, '');
    for (const m of sql.matchAll(/DELETE\s+rp[\s\S]*?r\.name\s*=\s*'reseller_admin'[\s\S]*?p\.name\s+IN\s*\(([^)]*)\)/gi)) {
      for (const name of m[1].matchAll(/'([^']+)'/g)) revoked.add(name[1]);
    }
  }
  return revoked;
}

test('after the migrations, reseller_admin holds no organization-wide permission', () => {
  const role = baselineRows('roles').find((r) => r.name === 'reseller_admin');
  const names = new Map(baselineRows('permissions').map((p) => [p.id, p.name]));
  const revoked = revokedByLaterMigrations();
  const held = baselineRows('role_permissions')
    .filter((rp) => rp.role_id === role.id)
    .map((rp) => names.get(rp.permission_id))
    .filter((name) => !revoked.has(name));
  expect(held.filter((name) => !ALLOWED.test(name)).sort()).toEqual([]);
  // It still works as a reseller role.
  expect(held).toEqual(expect.arrayContaining(['reseller_portal.dashboard', 'reseller_portal.manage_customers', 'resellers.view']));
});

test('the rollback restores exactly what migration 002 revokes', () => {
  const list = (file) => [...fs.readFileSync(file, 'utf8').replace(/--.*$/gm, '').match(/p\.name\s+IN\s*\(([^)]*)\)/i)[1].matchAll(/'([^']+)'/g)]
    .map((m) => m[1]).sort();
  const name = '002_reseller_admin_security_grants.sql';
  expect(list(path.join(MIGRATIONS, '..', 'rollbacks', name))).toEqual(list(path.join(MIGRATIONS, name)));
});
