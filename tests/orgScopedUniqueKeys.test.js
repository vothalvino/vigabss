// =============================================================================
// DB-18 — tenant-owned SKUs, IP pools and device serials are unique per org
// =============================================================================
// inventory_items.sku, ip_pools (network, mask, version) and
// devices.serial_number were globally unique. The application checks are
// scoped to the caller's organization, so a second tenant passed them and
// then hit the global key: a 409 that told it the value exists elsewhere.
// =============================================================================

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'database');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations', '490_org_scoped_unique_keys.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'rollbacks', '490_org_scoped_unique_keys.sql'), 'utf8');

function uniqueKeys(table) {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  const body = schema.slice(start, schema.indexOf(') ENGINE=', start));
  return [...body.matchAll(/UNIQUE KEY (\w+) \(([^)]+)\)/g)].map((m) => ({ name: m[1], cols: m[2].split(',').map((c) => c.trim()) }));
}

test.each([
  ['inventory_items', 'sku'],
  ['ip_pools', 'network'],
  ['devices', 'serial_number'],
])('every %s unique key on %s leads with organization_id', (table, col) => {
  const keys = uniqueKeys(table).filter((k) => k.cols.includes(col));
  expect(keys.length).toBeGreaterThan(0);
  for (const k of keys) expect(k.cols[0]).toBe('organization_id');
});

test('ip_assignments is keyed on its pool, which belongs to one organization', () => {
  expect(uniqueKeys('ip_assignments').find((k) => k.cols.includes('ip_address')).cols[0]).toBe('pool_id');
});

test('the migration adds each org-scoped key before dropping the global one', () => {
  for (const [neu, old] of [
    ['uq_inventory_items_org_sku', 'uq_inventory_items_sku'],
    ['uq_ip_pools_org_network_mask_ver', 'uq_ip_pools_network_mask_ver'],
    ['uq_devices_org_serial_number', 'uq_devices_serial_number'],
  ]) {
    const add = migration.indexOf(`ADD UNIQUE KEY ${neu}`);
    const drop = migration.indexOf(`DROP INDEX ${old}`);
    expect(add).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(add);
    expect(rollback).toContain(`ADD UNIQUE KEY ${old}`);
  }
  expect(migration).toContain('ADD KEY idx_devices_serial_number (serial_number)');
});
