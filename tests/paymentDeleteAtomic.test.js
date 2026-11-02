// =============================================================================
// DAL-08 — a payment delete and its money reversal commit together
// =============================================================================
// The soft delete committed first; the ledger-credit and allocation reversal
// ran afterwards in a hook whose failure was only logged, so a transient error
// left a deleted payment whose live allocations kept invoices 'paid'.

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
  orgScope: (req, _res, next) => { req.orgId = 5; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const { mockTxConnection } = require('./fixtures/mockTxConnection');
const app = require('../src/app');

const PAYMENT = { id: 70, organization_id: 5, client_id: 42, amount: '500.00', currency: 'MXN', status: 'completed' };

let failOn;
function wire() {
  db.query.mockImplementation(async (sql) => {
    if (failOn && failOn.test(sql)) throw new Error('lock wait timeout');
    if (/tipo_comprobante = 'P'/.test(sql)) return [[]];
    if (/SELECT DISTINCT invoice_id FROM payment_allocations/.test(sql)) return [[{ invoice_id: 10 }]];
    if (/AS allocated/.test(sql)) return [[{ total: '500.00', allocated: '0' }]];
    if (/FROM `?payments`?/.test(sql)) return [[PAYMENT]];
    if (/^\s*(UPDATE|DELETE|INSERT)/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
    return [[]];
  });
}

let conn;
beforeEach(() => {
  jest.clearAllMocks();
  failOn = null;
  conn = mockTxConnection(db);
  wire();
});

test('the reversal runs on the delete transaction', async () => {
  const res = await request(app).delete('/api/v1/payments/70');

  expect(res.status).toBe(204);
  const onTx = conn.execute.mock.calls.map(([sql]) => sql);
  expect(onTx.some(sql => /DELETE FROM client_balance_ledger/.test(sql))).toBe(true);
  expect(onTx.some(sql => /UPDATE payment_allocations SET deleted_at = NOW\(\)/.test(sql))).toBe(true);
  expect(onTx.some(sql => /UPDATE invoices SET status = 'issued'/.test(sql))).toBe(true);
  expect(onTx.some(sql => /UPDATE `?payments`? SET `?deleted_at/.test(sql))).toBe(true);
  expect(conn.commit).toHaveBeenCalledTimes(1);
});

test('a failed reversal rolls the delete back and is not reported as success', async () => {
  failOn = /UPDATE payment_allocations SET deleted_at = NOW\(\)/;
  const res = await request(app).delete('/api/v1/payments/70');

  expect(res.status).toBeGreaterThanOrEqual(500);
  expect(conn.rollback).toHaveBeenCalled();
  expect(conn.commit).not.toHaveBeenCalled();
  expect(conn.execute.mock.calls.some(([sql]) => /UPDATE `?payments`? SET `?deleted_at/.test(sql))).toBe(false);
});

test('restore re-credits and revives allocations inside its transaction', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/SELECT DISTINCT invoice_id FROM payment_allocations/.test(sql)) return [[{ invoice_id: 10 }]];
    if (/AS allocated/.test(sql)) return [[{ total: '500.00', allocated: '500.00' }]];
    if (/FROM `?payments`?/.test(sql)) return [[PAYMENT]];
    if (/^\s*(UPDATE|DELETE|INSERT)/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
    return [[]];
  });
  const res = await request(app).post('/api/v1/payments/70/restore');

  expect(res.status).toBe(200);
  const onTx = conn.execute.mock.calls.map(([sql]) => sql);
  expect(onTx.some(sql => /INSERT INTO client_balance_ledger/.test(sql))).toBe(true);
  expect(onTx.some(sql => /UPDATE payment_allocations SET deleted_at = NULL/.test(sql))).toBe(true);
  expect(conn.commit).toHaveBeenCalledTimes(1);
});
