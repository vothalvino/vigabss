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
// reseller ledger permissions go to admin only. Migration 005 adds
// reseller_app.bags (sealing cash bags); the cash bag and carrier
// administration stays with admin (tests/carrierGrants.test.js). Migration
// 008 adds reseller_app.statements (its own approved statements); generating,
// approving and settling statements stays with admin. This replays
// the baseline grants and every later migration's grants and revocations.
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
    'reseller_app.use', 'reseller_app.signup', 'reseller_app.collect', 'reseller_app.bags',
    'reseller_app.statements', 'reseller_app.tickets', 'reseller_portal.dashboard', 'reseller_portal.manage_customers',
  ]));
  // Cash bags are received, voided and handed out by the ISP only.
  expect(held.filter((name) => /^(?:cash_bags|carriers|carrier_app)\./.test(name))).toEqual([]);
  expect(held).not.toContain('resellers.view');
  // What a reseller owes is the ISP's record: never the reseller's to edit.
  expect(held).not.toContain('reseller_ledger.view');
  expect(held).not.toContain('reseller_ledger.manage');
  // Statements are drawn up, approved and settled by the ISP.
  expect(held.filter((name) => name.startsWith('reseller_settlements.'))).toEqual([]);
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

test('migration 008 grants the statements view to reseller_admin and the statement administration to admin', () => {
  const name = '008_reseller_settlements.sql';
  const sql = fs.readFileSync(path.join(MIGRATIONS, name), 'utf8').replace(/--.*$/gm, '');
  const grants = [...sql.matchAll(/INSERT\s+IGNORE\s+INTO\s+role_permissions[^;]*?p\.name\s+IN\s*\(([^)]*)\)[^;]*?r\.name\s*=\s*'(\w+)'/gi)]
    .map((m) => [m[2], names(m[1]).sort()]);
  const admin = ['reseller_app.statements', 'reseller_settlements.approve', 'reseller_settlements.manage', 'reseller_settlements.view'];
  expect(grants).toEqual([
    ['reseller_admin', ['reseller_app.statements']],
    ['admin', admin],
  ]);
  const seeded = names(sql.match(/INSERT IGNORE INTO permissions \(name, description, module\) VALUES([\s\S]*?);/)[1])
    .filter((n) => /^[a-z_]+\.[a-z_]+$/.test(n)).sort();
  expect(seeded).toEqual(admin);
  const rollback = fs.readFileSync(path.join(ROLLBACKS, name), 'utf8').replace(/--.*$/gm, '');
  expect(names(rollback.match(/DELETE FROM permissions WHERE name IN \(([^)]*)\)/i)[1]).sort()).toEqual(admin);
  const refuse = rollback.indexOf("SIGNAL SQLSTATE '45000'");
  expect(refuse).toBeGreaterThan(-1);
  expect(refuse).toBeLessThan(rollback.indexOf('DROP TABLE IF EXISTS reseller_settlements'));
});

test('migration 009 grants reseller_app.tickets to reseller_admin and admin, and the rollback drops it', () => {
  const name = '009_reseller_tickets_signing_links.sql';
  const sql = fs.readFileSync(path.join(MIGRATIONS, name), 'utf8').replace(/--.*$/gm, '');
  const grants = [...sql.matchAll(/INSERT\s+IGNORE\s+INTO\s+role_permissions[^;]*?p\.name\s+IN\s*\(([^)]*)\)[^;]*?r\.name\s*=\s*'(\w+)'/gi)]
    .map((m) => [m[2], names(m[1]).sort()]);
  expect(grants).toEqual([
    ['reseller_admin', ['reseller_app.tickets']],
    ['admin', ['reseller_app.tickets']],
  ]);
  const rollback = fs.readFileSync(path.join(ROLLBACKS, name), 'utf8').replace(/--.*$/gm, '');
  expect(names(rollback.match(/DELETE FROM permissions WHERE name IN \(([^)]*)\)/i)[1])).toEqual(['reseller_app.tickets']);
  expect(rollback.indexOf("SIGNAL SQLSTATE '45000'")).toBeLessThan(rollback.indexOf('DROP TABLE IF EXISTS document_signing_links'));
});
