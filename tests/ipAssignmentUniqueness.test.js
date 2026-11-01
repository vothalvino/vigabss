// =============================================================================
// NET-18 — ip_assignments are unique per pool, and assign-next moves on
// =============================================================================
// UNIQUE (ip_address, active_flag) spanned every tenant and pool and counted
// expired rows, while pools overlap freely across shared-database tenants. The
// second ISP reusing RFC 1918 space got a duplicate-key 409 that also told it
// the address existed elsewhere; one 'expired' row made assign-next pick and
// fail on it for ever; concurrent assign-next calls errored instead of moving
// on. Migration 486 keys on (pool_id, ip_address, live_flag).
// =============================================================================

const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));

const db = require('../src/config/database');
const { assignNextFreeIp } = require('../src/services/poolAssignmentService');

const POOL = { id: 10, organization_id: 1, ip_version: '4', network: '10.0.0.0/29', subnet_mask: null, gateway: null, excluded_ranges: null };
const dup = () => Object.assign(new Error("Duplicate entry '10.0.0.1'"), { code: 'ER_DUP_ENTRY', errno: 1062 });

beforeEach(() => {
  jest.clearAllMocks();
  // assignNextFreeIp runs on one transaction (the pool row is locked FOR UPDATE).
  db.getConnection.mockResolvedValue({
    query: (...args) => db.query(...args),
    beginTransaction: jest.fn().mockResolvedValue(), commit: jest.fn().mockResolvedValue(),
    rollback: jest.fn().mockResolvedValue(), release: jest.fn(),
  });
});

test('a candidate another writer took is skipped, not reported as a 409', async () => {
  const inserted = [];
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM ip_pools/.test(sql)) return [[POOL]];
    if (/SELECT ip_address FROM ip_assignments/.test(sql)) return [[]];
    if (/^INSERT INTO ip_assignments/.test(sql)) {
      inserted.push(params[2]);
      if (params[2] === '10.0.0.1') throw dup(); // taken concurrently, or held by an expired row before 486
      return [{ insertId: 7 }];
    }
    if (/FROM ip_assignments WHERE id = \?/.test(sql)) return [[{ id: 7, ip_address: inserted[inserted.length - 1], pool_id: 10, status: 'active' }]];
    return [[]];
  });
  const row = await assignNextFreeIp(10, { contractId: null, clientId: null, type: 'dynamic', orgId: 1 });
  expect(inserted).toEqual(['10.0.0.1', '10.0.0.2']);
  expect(row.ip_address).toBe('10.0.0.2');
});

test('other insert errors still propagate', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/FROM ip_pools/.test(sql)) return [[POOL]];
    if (/SELECT ip_address FROM ip_assignments/.test(sql)) return [[]];
    if (/^INSERT INTO ip_assignments/.test(sql)) throw Object.assign(new Error('lost connection'), { code: 'PROTOCOL_CONNECTION_LOST' });
    return [[]];
  });
  await expect(assignNextFreeIp(10, { type: 'dynamic', orgId: 1 })).rejects.toThrow(/lost connection/);
});

describe('the schema keys on pool and live rows', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8');
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS ip_assignments'), schema.indexOf('ENGINE', schema.indexOf('CREATE TABLE IF NOT EXISTS ip_assignments')));

  test('schema.sql', () => {
    expect(table).toMatch(/live_flag TINYINT\(1\) GENERATED ALWAYS AS \(IF\(deleted_at IS NULL AND status <> 'expired', 1, NULL\)\) STORED/);
    expect(table).toMatch(/UNIQUE KEY uq_ip_assignments_pool_ip \(pool_id, ip_address, live_flag\)/);
    expect(table).not.toMatch(/uq_ip_assignments_ip \(/);
  });

  test('migration 486 and its rollback', () => {
    const up = fs.readFileSync(path.join(__dirname, '../database/migrations/486_ip_assignments_pool_scoped_unique.sql'), 'utf8');
    const down = fs.readFileSync(path.join(__dirname, '../database/rollbacks/486_ip_assignments_pool_scoped_unique.sql'), 'utf8');
    expect(up).toMatch(/ADD UNIQUE KEY uq_ip_assignments_pool_ip \(pool_id, ip_address, live_flag\)/);
    expect(up).toMatch(/DROP INDEX uq_ip_assignments_ip/);
    expect(down).toMatch(/ADD UNIQUE KEY uq_ip_assignments_ip \(ip_address, active_flag\)/);
  });
});
