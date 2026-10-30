'use strict';
// =============================================================================
// VigaBSS 5.0 — CPE swap is bound to the caller's org (RTE-01)
// =============================================================================
// POST /cpe-management/devices/swap never checked either unit against
// req.orgId, and swapDevice loaded both by id alone. A tenant holding
// cpe_inventory.swap could move another tenant's subscriber/contract/ownership
// onto a unit, soft-delete that tenant's bridged devices row, and read both
// full cpe_devices rows back in the response.
//
// The db double behaves like MySQL: it filters cpe_devices by organization
// only when the emitted SQL carries an organization predicate, so an unscoped
// lookup finds the foreign unit exactly as the real table would.
// =============================================================================

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(),
  getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/eventBus', () => ({
  emit: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(), off: jest.fn(), once: jest.fn(), removeListener: jest.fn(),
}));

const config = require('../src/config');
const db = require('../src/config/database');
const cpeInventoryService = require('../src/services/cpeInventoryService');
const app = require('../src/app');

const ADMIN = { id: 1, email: 'a@b.c', role: 'admin', status: 'active', organization_id: 1 };
const token = () => jwt.sign({ sub: 1, email: 'a@b.c', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const auth = (r) => r.set('Authorization', `Bearer ${token()}`);

function freshUnits() {
  return [
    // org 1 (caller)
    { id: 11, organization_id: 1, lifecycle_state: 'assigned', subscriber_id: 100, contract_id: 900, ownership: 'rented', device_id: null, serial_number: 'A-OLD', acs_password_hash: 'h1' },
    { id: 12, organization_id: 1, lifecycle_state: 'in_stock', subscriber_id: null, contract_id: null, ownership: null, device_id: null, serial_number: 'A-NEW', acs_password_hash: 'h2' },
    // org 2 (victim)
    { id: 21, organization_id: 2, lifecycle_state: 'active', subscriber_id: 200, contract_id: 800, ownership: 'rented', device_id: 555, serial_number: 'B-OLD', acs_password_hash: 'secret-b' },
    { id: 22, organization_id: 2, lifecycle_state: 'in_stock', subscriber_id: null, contract_id: null, ownership: null, device_id: null, serial_number: 'B-NEW', acs_password_hash: 'secret-b2' },
  ];
}

let units;
let writes;

function orgFilter(sql, params, idIndex = 0) {
  // Mirrors MySQL: only narrow by org when the SQL actually binds it.
  const id = Number(params[idIndex]);
  let rows = units.filter((u) => u.id === id);
  if (/organization_id <=> \?|organization_id = \?/.test(sql)) {
    const org = params[idIndex + 1];
    rows = rows.filter((u) => u.organization_id === org
      || (/OR organization_id IS NULL/.test(sql) && u.organization_id === null));
  }
  return rows;
}

function handle(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  if (s.includes('`users`')) return [[ADMIN]];
  if (/^SELECT .* FROM `?cpe_devices`? WHERE/i.test(s) && /\bid = \?/.test(s)) {
    return [orgFilter(s, params).map((u) => ({ ...u }))];
  }
  if (/^UPDATE (cpe_devices|devices)\b/.test(s)) {
    writes.push({ sql: s, params });
    return [{ affectedRows: 1 }];
  }
  if (/^INSERT INTO devices/.test(s)) { writes.push({ sql: s, params }); return [{ insertId: 777 }]; }
  if (/^INSERT INTO cpe_lifecycle_history/.test(s)) return [{ insertId: 1 }];
  return [[]];
}

let conn;
beforeEach(() => {
  jest.clearAllMocks();
  units = freshUnits();
  writes = [];
  db.query.mockImplementation(async (sql, params) => handle(sql, params));
  db.execute.mockImplementation(async (sql, params) => handle(sql, params));
  conn = {
    beginTransaction: jest.fn().mockResolvedValue(),
    commit: jest.fn().mockResolvedValue(),
    rollback: jest.fn().mockResolvedValue(),
    release: jest.fn(),
    query: jest.fn(async (sql, params) => handle(sql, params)),
  };
  db.getConnection.mockResolvedValue(conn);
});

const URL = '/api/v1/cpe-management/devices/swap';

describe('POST /cpe-management/devices/swap', () => {
  it.each([
    ['both units foreign', 21, 22],
    ['foreign old unit', 21, 12],
    ['foreign new unit', 11, 22],
  ])('404s for %s and touches nothing', async (_label, oldId, newId) => {
    const res = await auth(request(app).post(URL)).send({ old_device_id: oldId, new_device_id: newId });
    expect(res.status).toBe(404);
    expect(writes).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('secret-b');
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('swaps two of the caller\'s own units', async () => {
    const res = await auth(request(app).post(URL)).send({ old_device_id: 11, new_device_id: 12 });
    expect(res.status).toBe(200);
    expect(conn.commit).toHaveBeenCalled();
  });
});

describe('cpeInventoryService.swapDevice (service boundary, without the route check)', () => {
  it('refuses foreign units even when called directly', async () => {
    await expect(cpeInventoryService.swapDevice({
      oldDeviceId: 21, newDeviceId: 22, orgId: 1, performedBy: 1,
    })).rejects.toMatchObject({ statusCode: 404 });
    expect(writes).toHaveLength(0);
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('locks both units in the caller\'s org', async () => {
    await cpeInventoryService.swapDevice({ oldDeviceId: 11, newDeviceId: 12, orgId: 1, performedBy: 1 });
    const loads = conn.query.mock.calls.filter(([s]) => /^SELECT \* FROM cpe_devices WHERE id = \?/.test(s) && /FOR UPDATE/.test(s));
    expect(loads).toHaveLength(2);
    for (const [, params] of loads) expect(params[1]).toBe(1);
  });

  it('transitionLifecycleState will not move another tenant\'s unit', async () => {
    await expect(cpeInventoryService.transitionLifecycleState(21, 'returned', { orgId: 1 }))
      .rejects.toMatchObject({ status: 404 });
    expect(writes).toHaveLength(0);
  });
});
