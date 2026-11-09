// =============================================================================
// Migration 010: the Manager user group and point_logins.create
// =============================================================================
// manager holds what admin holds minus the excluded areas (organization
// settings, staff users and groups, organizations, security administration,
// integrations, tokens, webhooks, PAC, CSD, payment gateways, data residency,
// AI provider settings, WireGuard admin, compliance exports). Its grant is
// computed from admin's in SQL, so this replays it: the baseline's admin rows
// plus every later migration's admin grants up to 010, filtered by the
// migration's own exclusion lists. A migration after 010 that gives admin a
// permission must give it to manager too unless it is excluded.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { baselineRows } = require('./helpers/baseline');

const MIGRATIONS = path.join(__dirname, '..', 'database', 'migrations');
const ROLLBACKS = path.join(MIGRATIONS, '..', 'rollbacks');
const FILE = '010_manager_role_bag_points.sql';

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8').replace(/--.*$/gm, '');
const names = (list) => [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const migrationFiles = () => fs.readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f) && !f.startsWith('001_')).sort();

/** Explicit `p.name IN (...)` grants of a role in one migration's SQL. */
function explicitGrants(sql, role) {
  const out = new Set();
  const grant = new RegExp(`INSERT\\s+(?:IGNORE\\s+)?INTO\\s+role_permissions[^;]*?p\\.name\\s+IN\\s*\\(([^)]*)\\)[^;]*?r\\.name\\s*=\\s*'${role}'`, 'gi');
  for (const m of sql.matchAll(grant)) for (const n of names(m[1])) out.add(n);
  return out;
}

/** Every permission's module: the baseline's rows plus later migrations' seeds. */
function modules() {
  const out = new Map(baselineRows('permissions').map((p) => [p.name, p.module || p.name.split('.')[0]]));
  for (const f of migrationFiles()) {
    const sql = read(MIGRATIONS, f);
    for (const m of sql.matchAll(/INSERT IGNORE INTO permissions \(name, description, module\) VALUES([\s\S]*?);/g)) {
      for (const row of m[1].matchAll(/\(\s*'([^']+)'\s*,\s*'(?:[^']|'')*'\s*,\s*'([^']+)'\s*\)/g)) out.set(row[1], row[2]);
    }
  }
  return out;
}

/** admin's permissions once every migration up to (and including) `upto` ran. */
function adminAt(upto) {
  const roles = new Map(baselineRows('roles').map((r) => [r.id, r.name]));
  const slugs = new Map(baselineRows('permissions').map((p) => [p.id, p.name]));
  const held = new Set(baselineRows('role_permissions').filter((rp) => roles.get(rp.role_id) === 'admin').map((rp) => slugs.get(rp.permission_id)));
  for (const f of migrationFiles()) {
    if (f > upto) break;
    for (const n of explicitGrants(read(MIGRATIONS, f), 'admin')) held.add(n);
  }
  return held;
}

const sql = read(MIGRATIONS, FILE);
const managerInsert = sql.match(/INSERT IGNORE INTO role_permissions[^;]*?m\.name = 'manager'[^;]*;/)[0];
const excludedModules = names(managerInsert.match(/COALESCE\(p\.module, ''\) NOT IN \(([^)]*)\)/)[1]);
const reIncluded = names(managerInsert.match(/OR p\.name IN \(([^)]*)\)/)[1]);
const excludedNames = names(managerInsert.match(/AND p\.name NOT IN \(([^)]*)\)/)[1]);
const MODULES = modules();
const isExcluded = (name) => excludedNames.includes(name)
  || (excludedModules.includes(MODULES.get(name) ?? '') && !reIncluded.includes(name));

/** manager's permissions as migration 010 grants them. */
const manager = new Set([...adminAt(FILE)].filter((n) => !isExcluded(n)));

test('migration 010 seeds the manager system group with a non-admin persona', () => {
  expect(sql).toMatch(/INSERT IGNORE INTO roles \(name, description, kind, is_system\) VALUES\s*\(\s*'manager',[^;]*?'billing', 1\)/);
});

test('point_logins.create is seeded and given to admin', () => {
  expect(MODULES.get('point_logins.create')).toBe('point_logins');
  expect(explicitGrants(sql, 'admin')).toEqual(new Set(['point_logins.create']));
  expect(manager.has('point_logins.create')).toBe(true);
});

test.each([
  'cash_bags.view', 'cash_bags.manage', 'cash_bags.receive', 'carriers.manage', 'resellers.create', 'resellers.update',
  'reseller_ledger.manage', 'reseller_settlements.approve', 'clients.update', 'invoices.view', 'payments.view',
  'tickets.update', 'users.view', 'webauthn.view', 'webauthn.create', 'webauthn.delete', 'audit_logs.view',
])('manager runs the operation: %s', (slug) => {
  expect(manager.has(slug)).toBe(true);
});

test.each([
  'settings.update', 'settings.view', 'email_settings.update', 'backup_settings.download', 'users.create', 'users.update',
  'users.delete', 'roles.view', 'roles.manage', 'organizations.update', 'admin_ip_allowlist.update', 'password_policy.update',
  'encryption_keys.update', 'firewall_rules.update', 'integration_connections.create', 'api_tokens.create', 'webhooks.create',
  'pac_providers.update', 'csd_certificates.create', 'payment_gateways.update', 'data_residency.manage', 'ai.providers.write',
  'ai.policy.write', 'wireguard.peers.admin', 'audit_export.view',
])('manager never holds %s', (slug) => {
  expect(manager.has(slug)).toBe(false);
});

test('every exclusion names a real permission or module, and admin keeps all of them', () => {
  const all = new Set(MODULES.keys());
  for (const n of [...excludedNames, ...reIncluded]) expect([n, all.has(n)]).toEqual([n, true]);
  const mods = new Set(MODULES.values());
  for (const m of excludedModules) expect([m, mods.has(m)]).toEqual([m, true]);
  expect(adminAt(FILE).has('settings.update')).toBe(true);
});

test('a migration after 010 that gives admin a permission gives it to manager too, unless excluded', () => {
  for (const f of migrationFiles().filter((x) => x > FILE)) {
    const later = read(MIGRATIONS, f);
    const toManager = explicitGrants(later, 'manager');
    for (const n of explicitGrants(later, 'admin')) {
      if (!isExcluded(n)) expect([f, n, toManager.has(n)]).toEqual([f, n, true]);
    }
  }
});

test('the rollback removes the permission and the grants, and the group only when nobody is in it', () => {
  const rollback = read(ROLLBACKS, FILE);
  expect(rollback).toMatch(/DELETE FROM permissions WHERE name IN \('point_logins\.create'\)/);
  expect(rollback).toMatch(/DELETE rp\s+FROM role_permissions rp\s+JOIN roles r ON r\.id = rp\.role_id\s+WHERE r\.name = 'manager'/);
  expect(rollback).toMatch(/DELETE r\s+FROM roles r\s+LEFT JOIN users u ON u\.group_id = r\.id\s+WHERE r\.name = 'manager'\s+AND r\.is_system = 1\s+AND u\.id IS NULL/);
});
