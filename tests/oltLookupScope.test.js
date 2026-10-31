// =============================================================================
// TNB-20 — OLT chassis / vendor-caps lookups and ONU detail joins are scoped
// =============================================================================
// GET /olt-management/:id/chassis and /:id/vendor-caps read the device's SNMP
// metrics and manufacturer/model by id alone, so any tenant could read any
// OLT's CPU, memory and temperature. The ONU detail list and detail joined
// devices and ports without an organization predicate.
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
const call = (method, path) => request(app)[method](`/api/v1${path}`)
  .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1');

// Device 900 is another tenant's OLT: only an id-only read finds it.
beforeEach(() => {
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params = []) => {
    if (/COUNT\(\*\)/.test(sql)) return [[{ total: 0 }]];
    const scoped = /organization_id/.test(sql.split('WHERE').slice(1).join('WHERE'));
    if (/FROM snmp_metrics/.test(sql) && !/JOIN devices/.test(sql)) return [[{ cpu_usage: 91, temperature_c: 60 }]];
    if (/FROM devices WHERE id = \?/.test(sql) && !scoped && String(params[0]) === '900') return [[{ manufacturer: 'Huawei', model: 'MA5800' }]];
    if (/FROM olt_vendor_capabilities/.test(sql)) return [[{ id: 1, vendor: 'Huawei' }]];
    return [[]];
  });
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

test.each([
  '/olt-management/900/chassis',
  '/olt-management/900/vendor-caps',
])('GET %s on another tenant\'s OLT is 404', async (path) => {
  const res = await call('get', path);
  expect(res.status).toBe(404);
  expect(res.body.data).toBeUndefined();
});

test('getOltChassisSummary reads metrics only through a visible device', async () => {
  const { getOltChassisSummary } = require('../src/services/ftthService');
  expect(await getOltChassisSummary(900, 1)).toBeNull();
  const [sql, params] = db.query.mock.calls.at(-1);
  expect(sql).toMatch(/JOIN devices d ON d\.id = m\.device_id/);
  expect(params).toEqual([900, 1]);
});

test.each(['/onu-management/details', '/onu-management/details/5'])('GET %s joins devices and ports within the detail\'s organization', async (path) => {
  await call('get', path);
  const sql = db.query.mock.calls.map(([s]) => s).find(s => /FROM onu_details od/.test(s) && !/COUNT/.test(s));
  expect(sql).toMatch(/d\.organization_id <=> od\.organization_id/);
  expect(sql).toMatch(/p\.organization_id <=> od\.organization_id/);
});
