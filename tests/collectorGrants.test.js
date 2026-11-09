// =============================================================================
// Migration 011: collector accounts — the collector group, reseller_app.cash
// =============================================================================
// A collector's login holds the reseller app's cash routes only (collect, its
// cash, bags and statements, and its own passkeys), never reseller_app.use
// (clients, leads, plans) or anything outside the app; resellerApp.js also
// refuses those routes to a collector-kind binding whatever it holds.
// reseller_app.cash goes to reseller_admin, admin and manager too. Replays
// every migration's grants after the baseline, like tests/carrierGrants.test.js.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { baselineRows } = require('./helpers/baseline');

const MIGRATIONS = path.join(__dirname, '..', 'database', 'migrations');
const ROLLBACKS = path.join(MIGRATIONS, '..', 'rollbacks');
const FILE = '011_collector_accounts.sql';

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8').replace(/--.*$/gm, '');
const names = (list) => [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);

function grantsOf(role) {
  const roles = new Map(baselineRows('roles').map((r) => [r.id, r.name]));
  const slugs = new Map(baselineRows('permissions').map((p) => [p.id, p.name]));
  const held = new Set(baselineRows('role_permissions').filter((rp) => roles.get(rp.role_id) === role).map((rp) => slugs.get(rp.permission_id)));
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => /^\d+_.*\.sql$/.test(x) && !x.startsWith('001_')).sort()) {
    const sql = read(MIGRATIONS, f);
    const grant = new RegExp(`INSERT\\s+(?:IGNORE\\s+)?INTO\\s+role_permissions[^;]*?p\\.name\\s+IN\\s*\\(([^)]*)\\)[^;]*?r\\.name\\s*=\\s*'${role}'`, 'gi');
    for (const m of sql.matchAll(grant)) for (const n of names(m[1])) held.add(n);
  }
  return [...held].sort();
}

const sql = read(MIGRATIONS, FILE);

test('migration 011 seeds the collector system group with a non-admin persona', () => {
  expect(sql).toMatch(/INSERT IGNORE INTO roles \(name, description, kind, is_system\) VALUES\s*\(\s*'collector',[^;]*?'billing', 1\)/);
});

test('the collector group holds the cash routes of the reseller app and its own passkeys only', () => {
  expect(grantsOf('collector')).toEqual([
    'reseller_app.bags', 'reseller_app.cash', 'reseller_app.collect', 'reseller_app.statements',
    'webauthn.create', 'webauthn.delete', 'webauthn.view',
  ]);
});

test.each(['reseller_admin', 'admin', 'manager'])('%s holds reseller_app.cash', (role) => {
  expect(grantsOf(role)).toContain('reseller_app.cash');
});

test('every cash route of the reseller app accepts reseller_app.cash; client, lead and plan routes do not', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', f), 'utf8');
  const app = src('resellerApp.js');
  const collect = src('resellerAppCollect.js');
  expect(app).toMatch(/router\.get\('\/me', requirePermission\('reseller_app\.use', 'reseller_app\.cash'\)/);
  for (const route of ["'/payments'", "'/payments/:id/receipt'", "'/cash-session'", "'/ledger'"]) {
    expect([route, new RegExp(`router\\.get\\(${route.replace(/[/:]/g, (c) => `\\${c}`)}, requirePermission\\('reseller_app\\.use', 'reseller_app\\.cash'\\)`).test(collect)]).toEqual([route, true]);
  }
  for (const route of ["'/clients'", "'/clients/:id'", "'/plans'", "'/leads'"]) {
    expect([route, app.includes(`router.get(${route}, requirePermission('reseller_app.use'),`)]).toEqual([route, true]);
  }
});

test('the schema changes are guarded and mirrored in schema.sql', () => {
  for (const col of ['kind', 'collection_fee_type', 'collection_fee_value']) {
    expect(sql).toMatch(new RegExp(`COLUMN_NAME = '${col}'[\\s\\S]*?ALTER TABLE resellers ADD COLUMN ${col}`));
  }
  expect(sql).toMatch(/COLUMN_TYPE NOT LIKE '%''collection_fee''%'/);
  const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
  expect(schema).toMatch(/kind\s+ENUM\('reseller', 'collector'\) NOT NULL DEFAULT 'reseller'/);
  expect(schema).toMatch(/'payout', 'collection_fee', 'collection_fee_reversal'\) NOT NULL/);
  expect(schema).toMatch(/total_collection_fee_reversal DECIMAL\(14, 2\) NOT NULL DEFAULT 0/);
});

test('the rollback refuses while collectors or fee lines exist, before it drops anything', () => {
  const rollback = read(ROLLBACKS, FILE);
  const refuse = rollback.indexOf("SIGNAL SQLSTATE '45000'");
  expect(refuse).toBeGreaterThan(-1);
  expect(rollback).toMatch(/SELECT 1 FROM resellers WHERE kind = 'collector'/);
  expect(rollback).toMatch(/entry_type IN \('collection_fee', 'collection_fee_reversal'\)/);
  for (const destructive of ['DROP COLUMN kind', 'DROP COLUMN collection_fee_type', 'DROP COLUMN total_collection_fee', "DELETE FROM permissions WHERE name IN ('reseller_app.cash')"]) {
    expect([destructive, rollback.indexOf(destructive) > refuse]).toEqual([destructive, true]);
  }
  expect(rollback).toMatch(/DELETE r\s+FROM roles r\s+LEFT JOIN users u ON u\.group_id = r\.id\s+WHERE r\.name = 'collector'\s+AND r\.is_system = 1\s+AND u\.id IS NULL/);
});
