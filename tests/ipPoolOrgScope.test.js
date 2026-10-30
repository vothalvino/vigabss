'use strict';
// =============================================================================
// VigaBSS 5.0 — IP pool allocation and assignments are org-bound (NET-07)
// =============================================================================
// POST /ip-pools/:id/assign-next passed req.orgId to a service that discarded
// it and loaded the pool by id alone, then inserted an ip_assignments row
// stamped with the POOL's organization and the body's unverified
// contract_id/client_id. POST/PUT /ip-assignments checked only IP uniqueness.
//
// The db double holds rows for two organizations and only filters by org when
// the emitted SQL actually binds it, so an unscoped lookup finds the foreign
// row exactly as MySQL would.
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
const app = require('../src/app');

const ADMIN = { id: 1, email: 'a@b.c', role: 'admin', status: 'active', organization_id: 1 };
const token = () => jwt.sign({ sub: 1, email: 'a@b.c', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const auth = (r) => r.set('Authorization', `Bearer ${token()}`);

const OWNERS = {
  ip_pools: { 10: 1, 20: 2 },
  contracts: { 100: 1, 200: 2 },
  clients: { 1000: 1, 2000: 2 },
  devices: { 5: 1, 6: 2 },
};
const POOLS = {
  10: { id: 10, organization_id: 1, ip_version: '4', network: '10.1.0.0/29', gateway: null, excluded_ranges: null },
  20: { id: 20, organization_id: 2, ip_version: '4', network: '10.2.0.0/29', gateway: null, excluded_ranges: null },
};

function handle(sql, params = []) {
  if (typeof sql === 'string' && sql.includes('`users`')) return [[ADMIN]];
  if (/FROM ip_pools/.test(sql) && /SELECT \*/.test(sql)) {
    const pool = POOLS[params[0]];
    if (!pool) return [[]];
    if (/organization_id <=> \?/.test(sql) && pool.organization_id !== params[1]) return [[]];
    return [[pool]];
  }
  const owned = /SELECT id FROM (ip_pools|contracts|clients|devices)\b/.exec(sql);
  if (owned) {
    const org = OWNERS[owned[1]][params[0]];
    return [org !== undefined && org === params[1] ? [{ id: params[0] }] : []];
  }
  if (/^INSERT INTO ip_assignments/.test(sql)) return [{ insertId: 77, affectedRows: 1 }];
  if (/^INSERT INTO `?ip_assignments`?/i.test(sql)) return [{ insertId: 78, affectedRows: 1 }];
  if (/FROM `?ip_assignments`?/i.test(sql) && /WHERE `?id`? = \?/.test(sql)) {
    return [[{ id: 77, organization_id: 1, pool_id: 10, ip_address: '10.1.0.1' }]];
  }
  if (/^UPDATE `?ip_assignments`?/i.test(sql)) return [{ affectedRows: 1 }];
  return [[]];
}

let conn;
beforeEach(() => {
  jest.clearAllMocks();
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

const insertsInto = (mock) => mock.mock.calls.filter(([s]) => /^INSERT INTO `?ip_assignments`?/i.test(s));

describe('POST /ip-pools/:id/assign-next', () => {
  it('404s on another tenant\'s pool and allocates nothing', async () => {
    const res = await auth(request(app).post('/api/v1/ip-pools/20/assign-next')).send({});
    expect(res.status).toBe(404);
    expect(insertsInto(conn.query)).toHaveLength(0);
    expect(insertsInto(db.query)).toHaveLength(0);
  });

  it('refuses another tenant\'s contract_id with 422', async () => {
    const res = await auth(request(app).post('/api/v1/ip-pools/10/assign-next')).send({ contract_id: 200 });
    expect(res.status).toBe(422);
    expect(insertsInto(conn.query)).toHaveLength(0);
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('refuses another tenant\'s client_id with 422', async () => {
    const res = await auth(request(app).post('/api/v1/ip-pools/10/assign-next')).send({ client_id: 2000 });
    expect(res.status).toBe(422);
    expect(insertsInto(conn.query)).toHaveLength(0);
  });

  it('allocates from an own pool under a row lock, in one transaction', async () => {
    const res = await auth(request(app).post('/api/v1/ip-pools/10/assign-next'))
      .send({ contract_id: 100, client_id: 1000 });
    expect(res.status).toBe(201);
    const poolLookup = conn.query.mock.calls.find(([s]) => /FROM ip_pools/.test(s));
    expect(poolLookup[0]).toMatch(/FOR UPDATE/);
    const [insert] = insertsInto(conn.query);
    expect(insert[1]).toEqual([10, 1, '10.1.0.1', 100, 1000, 'dynamic']);
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });
});

describe('POST/PUT /ip-assignments verify references', () => {
  it.each([
    ['pool_id', { pool_id: 20 }],
    ['contract_id', { pool_id: 10, contract_id: 200 }],
    ['client_id', { pool_id: 10, client_id: 2000 }],
    ['device_id', { pool_id: 10, device_id: 6 }],
  ])('POST with a foreign %s is a 422 and inserts nothing', async (_field, refs) => {
    const res = await auth(request(app).post('/api/v1/ip-assignments'))
      .send({ ip_address: '10.9.9.9', ...refs });
    expect(res.status).toBe(422);
    expect(insertsInto(db.query)).toHaveLength(0);
  });

  it('PUT moving an assignment into another tenant\'s pool is a 422', async () => {
    const res = await auth(request(app).put('/api/v1/ip-assignments/77')).send({ pool_id: 20 });
    expect(res.status).toBe(422);
    const updates = db.query.mock.calls.filter(([s]) => /^UPDATE `?ip_assignments`?/i.test(s));
    expect(updates).toHaveLength(0);
  });

  it('POST with own references is accepted', async () => {
    const res = await auth(request(app).post('/api/v1/ip-assignments'))
      .send({ ip_address: '10.1.0.5', pool_id: 10, contract_id: 100, device_id: 5 });
    expect(res.status).toBe(201);
  });
});
