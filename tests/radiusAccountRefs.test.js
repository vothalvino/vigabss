// =============================================================================
// TNB-26 — POST /radius works; PUT /radius keeps references in the tenant
// =============================================================================
// Radius.fillable left out client_id, so BaseModel.create dropped it and every
// POST /radius failed on the NOT NULL column. PUT had no ownership check: an
// org-A user could point an account at org B's contract, NAS or IP pool, and
// the account then showed up in B's credential listing and broke B's
// activation ('multiple RADIUS accounts').
// =============================================================================

const request = require('supertest');

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 8, role: 'admin' }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = 1; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/radiusService', () => ({
  ...jest.requireActual('../src/services/radiusService'),
  syncFreeradiusTables: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../src/config/database');
const { mockTxConnection } = require('./fixtures/mockTxConnection');
const app = require('../src/app');

// Org 1 owns client 10 (contract 20), client 11 (contract 21), NAS 30, pool 40.
// Org 2 owns client 90, contract 91, NAS 92 and pool 93.
const OWN = { clients: [10, 11], contracts: [20, 21], nas: [30], ip_pools: [40] };
const CONTRACT_CLIENT = { 20: 10, 21: 11 };
const ACCOUNT = { id: 5, organization_id: 1, client_id: 10, contract_id: 20, username: 'u1', status: 'active' };

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql, params = []) => {
    const owned = sql.match(/FROM `?(clients|contracts|nas|ip_pools)`? WHERE id = \?/);
    if (owned) {
      const id = Number(params[0]);
      if (!OWN[owned[1]].includes(id)) return [[]];
      return [[{ id, client_id: CONTRACT_CLIENT[id] }]];
    }
    if (/^INSERT INTO `?radius`?/.test(sql)) return [{ insertId: 5, affectedRows: 1 }];
    if (/FROM `?radius`?/.test(sql)) return [[ACCOUNT]];
    if (/^\s*(UPDATE|DELETE)/.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
  mockTxConnection(db);
});

const radiusInsert = () => db.query.mock.calls.find(([sql]) => /^INSERT INTO `?radius`?/.test(sql));
const radiusUpdate = () => db.query.mock.calls.find(([sql]) => /^UPDATE `?radius`?/.test(sql));

describe('POST /api/v1/radius', () => {
  test('stores the client', async () => {
    const res = await request(app).post('/api/v1/radius')
      .send({ client_id: 10, contract_id: 20, username: 'u1', password: 'p' });
    expect(res.status).toBe(201);
    const [sql, params] = radiusInsert();
    const cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map((c) => c.trim().replace(/`/g, ''));
    expect(params[cols.indexOf('client_id')]).toBe(10);
  });

  test.each([
    ['client_id', { client_id: 90 }],
    ['contract_id', { contract_id: 91 }],
    ['nas_id', { nas_id: 92 }],
    ['ipv4_pool_id', { ipv4_pool_id: 93 }],
    ['ipv6_pool_id', { ipv6_pool_id: 93 }],
  ])('refuses another tenant\'s %s', async (_field, over) => {
    const res = await request(app).post('/api/v1/radius')
      .send({ client_id: 10, username: 'u1', password: 'p', ...over });
    expect(res.status).toBe(422);
    expect(radiusInsert()).toBeUndefined();
  });

  test('refuses a contract of a different client', async () => {
    const res = await request(app).post('/api/v1/radius')
      .send({ client_id: 10, contract_id: 21, username: 'u1', password: 'p' });
    expect(res.status).toBe(422);
    expect(radiusInsert()).toBeUndefined();
  });
});

describe('PUT /api/v1/radius/:id', () => {
  test.each([
    ['contract_id', { contract_id: 91 }],
    ['nas_id', { nas_id: 92 }],
    ['ipv4_pool_id', { ipv4_pool_id: 93 }],
    ['ipv6_pool_id', { ipv6_pool_id: 93 }],
  ])('refuses another tenant\'s %s', async (_field, body) => {
    const res = await request(app).put('/api/v1/radius/5').send(body);
    expect(res.status).toBe(422);
    expect(radiusUpdate()).toBeUndefined();
  });

  test('refuses moving the account to another client', async () => {
    const res = await request(app).put('/api/v1/radius/5').send({ client_id: 11 });
    expect(res.status).toBe(422);
    expect(radiusUpdate()).toBeUndefined();
  });

  test('refuses another client\'s contract', async () => {
    const res = await request(app).put('/api/v1/radius/5').send({ contract_id: 21 });
    expect(res.status).toBe(422);
  });

  test('accepts its own NAS and pool', async () => {
    const res = await request(app).put('/api/v1/radius/5').send({ nas_id: 30, ipv4_pool_id: 40 });
    expect(res.status).toBe(200);
    expect(radiusUpdate()).toBeTruthy();
  });
});
