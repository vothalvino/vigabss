// =============================================================================
// reseller_admin holds only reseller-scoped grants and its own passkeys
// =============================================================================
// Migration 335 (pre-release history, now in the baseline) granted the group
// organization-wide security views and admin_ip_allowlist.create. A reseller
// user is confined to its reseller (middleware/resellerScope.js), but those
// routes are not reseller-scoped: on a test install a bound reseller user read the
// firewall/DDoS/blocklist rules and staged an admin IP allowlist entry, which,
// activated, locks the ISP's administrators out. Migration 002 revokes them.
// Migration 003 moves the group to the reseller app: it gains reseller_app.*
// and loses the reseller administration views (resellers.view and the plan
// price, commission, IP pool, bandwidth quota, OLT port and billing entity
// views). Migration 004 adds reseller_app.collect (cash collection); the
// reseller ledger permissions go to admin only. This replays the baseline
// grants and every later migration's grants and revocations.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { baselineRows } = require('./helpers/baseline');

const MIGRATIONS = path.join(__dirname, '..', 'database', 'migrations');
const ROLLBACKS = path.join(MIGRATIONS, '..', 'rollbacks');

// Grants a reseller user may hold: the reseller app, the reseller portal
// (scoped by resellerScope), and the caller's own passkeys.
const ALLOWED = /^(?:reseller_app|reseller_portal|webauthn)\.[a-z_]+$/;

const laterMigrations = () => fs.readdirSync(MIGRATIONS)
  .filter((f) => /^\d+_.*\.sql$/.test(f) && !f.startsWith('001_'))
  .sort()
  .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').replace(/--.*$/gm, ''));

const names = (list) => [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);

function replayLaterMigrations(held) {
  for (const sql of laterMigrations()) {
    for (const m of sql.matchAll(/INSERT\s+(?:IGNORE\s+)?INTO\s+role_permissions[^;]*?p\.name\s+IN\s*\(([^)]*)\)[^;]*?r\.name\s*=\s*'reseller_admin'/gi)) {
      for (const name of names(m[1])) held.add(name);
    }
    for (const m of sql.matchAll(/DELETE\s+rp[^;]*?r\.name\s*=\s*'reseller_admin'[^;]*?p\.name\s+IN\s*\(([^)]*)\)/gi)) {
      for (const name of names(m[1])) held.delete(name);
    }
  }
  return held;
}

function heldAfterMigrations() {
  const role = baselineRows('roles').find((r) => r.name === 'reseller_admin');
  const byId = new Map(baselineRows('permissions').map((p) => [p.id, p.name]));
  const held = new Set(baselineRows('role_permissions')
    .filter((rp) => rp.role_id === role.id)
    .map((rp) => byId.get(rp.permission_id)));
  return replayLaterMigrations(held);
}

test('after the migrations, reseller_admin holds no organization-wide permission', () => {
  const held = [...heldAfterMigrations()];
  expect(held.filter((name) => !ALLOWED.test(name)).sort()).toEqual([]);
  // It still works as a reseller role.
  expect(held).toEqual(expect.arrayContaining([
    'reseller_app.use', 'reseller_app.signup', 'reseller_app.collect',
    'reseller_portal.dashboard', 'reseller_portal.manage_customers',
  ]));
  expect(held).not.toContain('resellers.view');
  // What a reseller owes is the ISP's record: never the reseller's to edit.
  expect(held).not.toContain('reseller_ledger.view');
  expect(held).not.toContain('reseller_ledger.manage');
  // Nor the staff cash-reconciliation surface (its own cash box is in the app).
  expect(held.filter((name) => name.startsWith('cash_reconciliation.'))).toEqual([]);
});

test('migration 004 grants the collection to reseller_admin and admin, and the ledger to admin', () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS, '004_reseller_app_phase2.sql'), 'utf8').replace(/--.*$/gm, '');
  const grants = [...sql.matchAll(/INSERT\s+IGNORE\s+INTO\s+role_permissions[^;]*?p\.name\s+IN\s*\(([^)]*)\)[^;]*?r\.name\s*=\s*'(\w+)'/gi)]
    .map((m) => [m[2], names(m[1]).sort()]);
  expect(grants).toEqual([
    ['reseller_admin', ['reseller_app.collect']],
    ['admin', ['reseller_app.collect', 'reseller_ledger.manage', 'reseller_ledger.view']],
  ]);
  const seeded = names(sql.match(/INSERT IGNORE INTO permissions \(name, description, module\) VALUES([\s\S]*?);/)[1])
    .filter((n) => /^[a-z_]+\.[a-z_]+$/.test(n)).sort();
  expect(seeded).toEqual(['reseller_app.collect', 'reseller_ledger.manage', 'reseller_ledger.view']);
});

test('the rollback of migration 004 refuses while cash records exist and drops the permissions', () => {
  const rollback = fs.readFileSync(path.join(ROLLBACKS, '004_reseller_app_phase2.sql'), 'utf8').replace(/--.*$/gm, '');
  const refuse = rollback.indexOf("SIGNAL SQLSTATE '45000'");
  expect(refuse).toBeGreaterThan(-1);
  expect(refuse).toBeLessThan(rollback.indexOf('DROP TABLE IF EXISTS reseller_ledger_entries'));
  expect(refuse).toBeLessThan(rollback.indexOf('DROP COLUMN reseller_id'));
  expect(names(rollback.match(/DELETE FROM permissions WHERE name IN \(([^)]*)\)/i)[1]).sort())
    .toEqual(['reseller_app.collect', 'reseller_ledger.manage', 'reseller_ledger.view']);
});

// The first `p.name IN (...)` list of a file, sorted.
const firstList = (file) => names(fs.readFileSync(file, 'utf8').replace(/--.*$/gm, '').match(/p\.name\s+IN\s*\(([^)]*)\)/i)[1]).sort();

test('the rollback restores exactly what migration 002 revokes', () => {
  const name = '002_reseller_admin_security_grants.sql';
  expect(firstList(path.join(ROLLBACKS, name))).toEqual(firstList(path.join(MIGRATIONS, name)));
});

test('the rollback of migration 003 restores the views it revokes and drops the app permissions', () => {
  const name = '003_reseller_app_phase1.sql';
  const migration = fs.readFileSync(path.join(MIGRATIONS, name), 'utf8').replace(/--.*$/gm, '');
  const rollback = fs.readFileSync(path.join(ROLLBACKS, name), 'utf8').replace(/--.*$/gm, '');
  const revoked = names(migration.match(/DELETE\s+rp[\s\S]*?p\.name\s+IN\s*\(([^)]*)\)/i)[1]).sort();
  expect(revoked).toHaveLength(7);
  expect(firstList(path.join(ROLLBACKS, name))).toEqual(revoked);
  expect(names(rollback.match(/DELETE FROM permissions WHERE name IN \(([^)]*)\)/i)[1]).sort())
    .toEqual(['reseller_app.signup', 'reseller_app.use']);
});
