// =============================================================================
// TNB-19 — reseller allocations name only this organization's rows
// =============================================================================
// Plan prices, IP-pool allocations and OLT-port assignments stored any plan,
// pool or port id, and their lists joined those tables without an
// organization predicate, returning the other tenant's plan prices, pool
// networks and port names.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const app = require('../src/app');

const token = jwt.sign({ sub: 1, email: 'u@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const call = (method, path, body) => request(app)[method](`/api/v1${path}`)
  .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1').send(body);

// Reseller 3 is this organization's; plan/pool/port 900 are not.
beforeEach(() => {
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    if (/^\s*(INSERT|UPDATE)/.test(sql)) return [{ insertId: 7, affectedRows: 1 }];
    if (/FROM resellers WHERE id = \?/.test(sql)) return [[{ id: 3, organization_id: 1, status: 'active' }]];
    return [[]];
  });
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

test.each([
  ['/resellers/3/plan-prices', { plan_id: 900, custom_price: 10 }, 'reseller_plan_prices'],
  ['/resellers/3/ip-pools', { ip_pool_id: 900 }, 'reseller_ip_pool_allocations'],
  ['/resellers/3/olt-ports', { olt_port_id: 900 }, 'reseller_olt_port_assignments'],
])('POST %s with another tenant\'s id is refused', async (path, body, table) => {
  const res = await call('post', path, body);
  expect(res.status).toBe(422);
  expect(db.query.mock.calls.some(([sql]) => new RegExp(`INSERT (IGNORE )?INTO ${table}`).test(sql))).toBe(false);
});

test.each([
  ['/resellers/3/plan-prices', /JOIN plans p/],
  ['/resellers/3/ip-pools', /JOIN ip_pools p/],
  ['/resellers/3/olt-ports', /JOIN olt_ports p/],
])('GET %s joins only this organization\'s rows', async (path, join) => {
  await call('get', path);
  const [sql, params] = db.query.mock.calls.find(([s]) => join.test(s));
  expect(sql).toMatch(/p\.organization_id <=> \?/);
  expect(params).toEqual(['3', 1]);
});
