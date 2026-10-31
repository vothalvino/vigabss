// =============================================================================
// RTE-04 — a service order's assignee must be able to work this org's orders
// =============================================================================
// assertServiceOrderFks checked client, lead, plan and contract but not
// assigned_to. Starting the order dispatched its install work order to that
// user and put the visit's title and address in their notification bell,
// whichever tenant they belonged to; the work-order views then showed their
// name.
// =============================================================================

jest.mock('../src/config/database', () => {
  const conn = { query: jest.fn(), execute: jest.fn(), beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() };
  return {
    query: jest.fn(),
    execute: jest.fn(),
    getConnection: jest.fn().mockResolvedValue(conn),
    close: jest.fn(),
    pool: { end: jest.fn() },
    __conn: conn,
  };
});
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

beforeEach(() => {
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    if (/^\s*(INSERT|UPDATE)/.test(sql)) return [{ insertId: 7, affectedRows: 1 }];
    if (/COUNT\(\*\)/.test(sql)) return [[{ total: 0 }]];
    if (/FROM `?service_orders`? WHERE/.test(sql)) return [[{ id: 5, organization_id: 1, status: 'new', order_type: 'new_install' }]];
    return [[]];
  });
  db.__conn.query.mockReset().mockResolvedValue([[]]);
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
  // User 900 holds no work-order permission in organization 1.
  User.hasEffectivePermission.mockImplementation(async (userId) => Number(userId) !== 900);
});
const wroteServiceOrder = () => [...db.query.mock.calls, ...db.__conn.query.mock.calls]
  .some(([sql]) => /^\s*(INSERT INTO|UPDATE) `?service_orders`?/.test(sql));

test.each([
  ['post', '/service-orders', { order_type: 'new_install', assigned_to: 900 }],
  ['put', '/service-orders/5', { assigned_to: 900 }],
  ['patch', '/service-orders/5', { assigned_to: 900 }],
])('%s %s assigning a user outside the organization is refused', async (method, path, body) => {
  const res = await call(method, path, body);
  expect(res.status).toBe(422);
  expect(User.hasEffectivePermission).toHaveBeenCalledWith(900, 1, 'work_orders.update');
  expect(wroteServiceOrder()).toBe(false);
});

test('the work-order assignment bell skips a user who cannot see the organization\'s work orders', async () => {
  const eventBus = require('../src/services/eventBus');
  const { registerHooks } = require('../src/services/notificationHooks');
  registerHooks();
  await eventBus.emit('work_order.assigned', { organizationId: 1, workOrder: { id: 42, title: 'Installation — SO-1', assigned_to: 900, address: 'Calle 1' } });
  expect(db.query.mock.calls.some(([sql]) => /INSERT INTO `notifications`/.test(sql))).toBe(false);
});

test('work-order views show an assignee only when they belong to the work order\'s organization', async () => {
  await call('get', '/work-orders');
  await call('get', '/work-orders/5');
  const joins = db.query.mock.calls.map(([sql]) => sql).filter(sql => /LEFT JOIN users u ON u\.id = wo\.assigned_to/.test(sql));
  expect(joins.length).toBe(2);
  for (const sql of joins) expect(sql).toMatch(/ou\.organization_id = wo\.organization_id/);
});
