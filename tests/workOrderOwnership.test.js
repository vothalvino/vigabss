// =============================================================================
// TNB-14 — work-order materials and targets stay in the tenant
// =============================================================================
// The materials endpoints bound only work_order_id, so another tenant's work
// order could be read, added to or emptied by id. Work orders also stored any
// client/site/device/contract/ticket/service-order id, and the list and detail
// joined those rows without an organization predicate, showing their names.
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

// Work order 900 and every id 900 belong to another organization.
beforeEach(() => {
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) return [{ insertId: 7, affectedRows: 1 }];
    if (/COUNT\(\*\)/.test(sql)) return [[{ total: 0 }]];
    if (/FROM work_order_materials WHERE work_order_id = \?/.test(sql)) return [[{ id: 1, item_name: 'tenant-2 drop cable' }]];
    return [[]];
  });
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
});
const touched = re => db.query.mock.calls.some(([sql]) => re.test(sql));

test.each([
  ['get', '/work-orders/900/materials', undefined],
  ['post', '/work-orders/900/materials', { item_name: 'connector' }],
  ['delete', '/work-orders/900/materials/1', undefined],
])('%s %s on another tenant\'s work order is 404', async (method, path, body) => {
  const res = await call(method, path, body);
  expect(res.status).toBe(404);
  expect(JSON.stringify(res.body)).not.toContain('tenant-2');
  expect(touched(/^\s*(INSERT INTO|DELETE FROM) work_order_materials/)).toBe(false);
});

test.each([
  ['post', '/work-orders', { title: 'Install', client_id: 900 }],
  ['post', '/work-orders', { title: 'Install', site_id: 900 }],
  ['post', '/work-orders', { title: 'Install', device_id: 900 }],
  ['put', '/work-orders/5', { title: 'Install', status: 'pending', priority: 'medium', client_id: 900 }],
  ['patch', '/work-orders/5', { device_id: 900 }],
])('%s %s %j with another tenant\'s target is refused', async (method, path, body) => {
  // Work order 5 is this organization's; the target id 900 is not.
  db.query.mockImplementation(async (sql) => {
    if (/^\s*(INSERT|UPDATE)/.test(sql)) return [{ insertId: 7, affectedRows: 1 }];
    if (/SELECT \* FROM work_orders WHERE id = \? AND organization_id = \?/.test(sql)) return [[{ id: 5, organization_id: 1, status: 'pending', work_type: 'repair' }]];
    return [[]];
  });
  const res = await call(method, path, body);
  expect(res.status).toBe(422);
  expect(touched(/^\s*(INSERT INTO|UPDATE) work_orders/)).toBe(false);
});

test('list and detail join targets only within the work order\'s organization', async () => {
  await call('get', '/work-orders');
  await call('get', '/work-orders/5');
  const joins = db.query.mock.calls.map(([sql]) => sql).filter(sql => /LEFT JOIN clients c/.test(sql));
  expect(joins.length).toBe(2);
  for (const sql of joins) {
    expect(sql).toMatch(/c\.organization_id = wo\.organization_id/);
    expect(sql).toMatch(/s\.organization_id = wo\.organization_id/);
    expect(sql).toMatch(/d\.organization_id = wo\.organization_id/);
  }
});
