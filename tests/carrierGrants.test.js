// =============================================================================
// Migration 005: the carrier group and the cash bag permissions
// =============================================================================
// A carrier works only in the carrier app, so its group holds the carrier app
// and its own passkeys and nothing else; the fence keeps it out of every other
// route whatever it is later given. The cash bag and carrier administration
// permissions go to admin (which holds every non-platform permission, the
// seed invariant of tests/test_seed_data.sql C2), and reseller_app.bags to
// reseller_admin and admin. This replays the grants of every migration after
// the baseline, one INSERT per role (WHERE r.name = '<role>'), like
// tests/resellerAdminGrants.test.js.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'database', 'migrations');
const ROLLBACKS = path.join(MIGRATIONS, '..', 'rollbacks');
const FILE = '005_reseller_cash_bags.sql';

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8').replace(/--.*$/gm, '');
const names = (list) => [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);

const laterMigrations = () => fs.readdirSync(MIGRATIONS)
  .filter((f) => /^\d+_.*\.sql$/.test(f) && !f.startsWith('001_'))
  .sort()
  .map((f) => read(MIGRATIONS, f));

/** What a role holds after the later migrations' grants and revocations. */
function grantsOf(role) {
  const held = new Set();
  for (const sql of laterMigrations()) {
    const grant = new RegExp(`INSERT\\s+(?:IGNORE\\s+)?INTO\\s+role_permissions[^;]*?p\\.name\\s+IN\\s*\\(([^)]*)\\)[^;]*?r\\.name\\s*=\\s*'${role}'`, 'gi');
    for (const m of sql.matchAll(grant)) for (const name of names(m[1])) held.add(name);
    const revoke = new RegExp(`DELETE\\s+rp[^;]*?r\\.name\\s*=\\s*'${role}'[^;]*?p\\.name\\s+IN\\s*\\(([^)]*)\\)`, 'gi');
    for (const m of sql.matchAll(revoke)) for (const name of names(m[1])) held.delete(name);
  }
  return [...held].sort();
}

const NEW_PERMISSIONS = [
  'carrier_app.pickup', 'carrier_app.use', 'carriers.manage', 'cash_bags.manage', 'cash_bags.receive',
  'cash_bags.view', 'reseller_app.bags',
];

test('migration 005 seeds the carrier system group with a persona', () => {
  const sql = read(MIGRATIONS, FILE);
  expect(sql).toMatch(/INSERT IGNORE INTO roles \(name, description, kind, is_system\) VALUES\s*\(\s*'carrier',[^;]*?'readonly', 1\)/);
});

test('the carrier group holds only the carrier app and its own passkeys', () => {
  const held = grantsOf('carrier');
  expect(held).toEqual(['carrier_app.pickup', 'carrier_app.use', 'webauthn.create', 'webauthn.delete', 'webauthn.view']);
  expect(held.filter((n) => !/^(?:carrier_app|webauthn)\./.test(n))).toEqual([]);
});

test('migration 005 seeds the new permissions and grants every one to admin, and the bags to reseller_admin', () => {
  const sql = read(MIGRATIONS, FILE);
  const seeded = names(sql.match(/INSERT IGNORE INTO permissions \(name, description, module\) VALUES([\s\S]*?);/)[1])
    .filter((n) => /^[a-z_]+\.[a-z_]+$/.test(n)).sort();
  expect(seeded).toEqual(NEW_PERMISSIONS);
  expect(grantsOf('admin')).toEqual(expect.arrayContaining(NEW_PERMISSIONS));
  expect(grantsOf('reseller_admin')).toContain('reseller_app.bags');
  // A reseller never administers bags or carriers.
  expect(grantsOf('reseller_admin').filter((n) => /^(?:cash_bags|carriers|carrier_app)\./.test(n))).toEqual([]);
  // One INSERT per role.
  const perRole = [...sql.matchAll(/INSERT\s+IGNORE\s+INTO\s+role_permissions[^;]*?r\.name\s*=\s*'(\w+)'/gi)].map((m) => m[1]);
  expect(perRole).toEqual(['carrier', 'reseller_admin', 'admin']);
});

test('the rollback refuses once a bag left stock or the ledger names a bag, before it drops anything', () => {
  const rollback = read(ROLLBACKS, FILE);
  const refuse = rollback.indexOf("SIGNAL SQLSTATE '45000'");
  expect(refuse).toBeGreaterThan(-1);
  expect(rollback).toMatch(/IF EXISTS \(SELECT 1 FROM cash_bags WHERE status <> 'in_stock' LIMIT 1\) THEN\s+SIGNAL SQLSTATE '45000'\s+SET MESSAGE_TEXT = 'Rollback 005 refused: cash bags have left stock and carry money history'/);
  expect(rollback).toMatch(/IF EXISTS \(SELECT 1 FROM reseller_ledger_entries WHERE cash_bag_id IS NOT NULL LIMIT 1\) THEN\s+SIGNAL SQLSTATE '45000'\s+SET MESSAGE_TEXT = 'Rollback 005 refused: reseller ledger entries record received cash bags'/);
  for (const destructive of ['DROP TABLE IF EXISTS cash_bags', 'DROP TABLE IF EXISTS cash_bag_events', 'DROP COLUMN cash_bag_id', 'DELETE FROM permissions']) {
    expect([destructive, rollback.indexOf(destructive) > refuse]).toEqual([destructive, true]);
  }
  expect(names(rollback.match(/DELETE FROM permissions WHERE name IN \(([^)]*)\)/i)[1]).sort()).toEqual(NEW_PERMISSIONS);
  // A carrier group still in use is kept (users.group_id is ON DELETE RESTRICT).
  expect(rollback).toMatch(/LEFT JOIN users u ON u\.group_id = r\.id[\s\S]*?u\.id IS NULL/);
});

test('the migration and its rollback create and drop the same tables', () => {
  const sql = read(MIGRATIONS, FILE);
  const rollback = read(ROLLBACKS, FILE);
  const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort();
  const dropped = [...rollback.matchAll(/DROP TABLE IF EXISTS (\w+)/g)].map((m) => m[1]).sort();
  expect(created).toEqual(['carrier_reseller_assignments', 'cash_bag_events', 'cash_bags']);
  expect(dropped).toEqual(created);
});
