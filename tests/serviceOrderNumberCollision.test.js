// =============================================================================
// RTE-05 — a caller-chosen order_number cannot block the tenant's numbering
// =============================================================================
// POST took req.body.order_number as is, and PUT/PATCH could rename an order
// to anything (order_number was fillable). A number equal to the next
// SO-###### value made every later auto-numbered create, and contract
// activation, fail on the unique key until the order was renamed.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/lifecycleService', () => ({
  nextOrderNumber: jest.fn(), seedDefaultTasks: jest.fn(), startOrder: jest.fn(), completeOrder: jest.fn(), cancelOrder: jest.fn(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const ServiceOrder = require('../src/models/ServiceOrder');
const lifecycleService = require('../src/services/lifecycleService');
const app = require('../src/app');

const token = jwt.sign({ sub: 1, email: 'admin@example.com', role: 'admin', orgId: 42 }, config.jwt.secret, { expiresIn: '1h' });

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql) => {
    if (/WHERE id = \?/.test(sql)) return [[{ id: 1, role: 'admin', status: 'active', organization_id: 42 }]];
    return [[]];
  });
});

test('a manual number a live order holds is a 409 naming that order, and draws nothing', async () => {
  const conn = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    query: jest.fn(async (sql) => (/FROM service_orders WHERE organization_id <=> \? AND order_number = \?/.test(sql) ? [[{ id: 31 }]] : [[]])),
  };
  db.getConnection.mockResolvedValue(conn);

  const res = await request(app).post('/api/v1/service-orders').set('Authorization', `Bearer ${token}`)
    .send({ order_type: 'new_install', order_number: 'SO-000016' });

  expect(res.status).toBe(409);
  expect(res.body.error.message).toMatch(/SO-000016 is already used by service order #31/);
  expect(conn.rollback).toHaveBeenCalled();
  expect(lifecycleService.nextOrderNumber).not.toHaveBeenCalled();
  expect(conn.query.mock.calls.some(([sql]) => /INSERT INTO/.test(sql))).toBe(false);
});

test('an update cannot rename an order onto the sequence', () => {
  expect(ServiceOrder.fillable).not.toContain('order_number');
});
