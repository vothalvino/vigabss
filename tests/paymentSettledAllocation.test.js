// =============================================================================
// DAL-02 — only a completed payment may settle invoices
// =============================================================================
// A pending, failed, refunded or cancelled payment could be allocated: the
// invoice was marked paid, a suspended contract reconnected, and a REP stamped
// at SAT for money that never arrived. Every allocation path now refuses with
// 422 PAYMENT_NOT_SETTLED before writing anything.
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
const repService = require('../src/services/repService');
const paymentPlanService = require('../src/services/paymentPlanService');
const app = require('../src/app');

const token = jwt.sign({ sub: 1, email: 'admin@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });

let payment;
let writes;

// Answers by statement; records every write so a test can prove none happened.
function route(sql) {
  if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
    writes.push(sql);
    return [{ affectedRows: 1, insertId: 1 }];
  }
  if (/FROM payments\b/i.test(sql)) return [[payment]];
  if (/FROM invoices\b/i.test(sql)) return [[{ id: 50, organization_id: 1, client_id: 10, total: '100.00', status: 'issued', balance_due: '100.00' }]];
  if (/FROM payment_allocations/i.test(sql)) return [[{ id: 7, payment_id: 3, invoice_id: 50, amount: '100.00', allocated: 0 }]];
  if (/FROM cfdi_documents/i.test(sql)) return [[{ id: 1, uuid: 'U', serie: 'A', folio: '1', total: '100.00' }]];
  if (/FROM payment_plan_installments/i.test(sql)) return [[{ id: 1, plan_id: 1, sequence: 1, status: 'pending', invoice_id: 50, amount: '100.00' }]];
  if (/FROM payment_plans/i.test(sql)) return [[{ id: 1, organization_id: 1, status: 'active' }]];
  return [[]];
}

const conn = {
  beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  execute: jest.fn(async sql => route(sql)),
  query: jest.fn(async sql => route(sql)),
};

beforeEach(() => {
  jest.clearAllMocks();
  writes = [];
  payment = { id: 3, organization_id: 1, client_id: 10, amount: '100.00', currency: 'MXN', status: 'pending', deleted_at: null };
  db.query.mockImplementation(async sql => route(sql));
  db.getConnection.mockResolvedValue(conn);
  User.findById.mockResolvedValue({ id: 1, email: 'admin@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

const post = (path, body) => request(app).post(path).set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1').send(body);

describe.each(['pending', 'failed', 'refunded', 'cancelled'])('a %s payment', (status) => {
  beforeEach(() => { payment.status = status; });

  test('POST /payments/:id/allocate is refused and writes nothing', async () => {
    const res = await post('/api/v1/payments/3/allocate', { invoice_id: 50, amount: 100 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_NOT_SETTLED');
    expect(writes).toEqual([]);
  });

  test('POST /payments/:id/allocate-auto is refused, rolled back and writes nothing', async () => {
    const res = await post('/api/v1/payments/3/allocate-auto', {});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_NOT_SETTLED');
    expect(conn.rollback).toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  test('POST /payments/:id/reallocate is refused and writes nothing', async () => {
    const res = await post('/api/v1/payments/3/reallocate', { from_invoice_id: 50, to_invoice_id: 51 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_NOT_SETTLED');
    expect(writes).toEqual([]);
  });

  test('no REP is generated for it', async () => {
    const result = await repService.generateRepForAllocation(3, 50, 100, 1);
    expect(result).toEqual({ generated: false, reason: 'PAYMENT_NOT_SETTLED' });
  });

  test('it cannot pay a payment-plan installment', async () => {
    await expect(paymentPlanService.payInstallment(1, 1, 3, 1)).rejects.toThrow(/Only a completed payment/);
    expect(writes).toEqual([]);
  });
});

test('a completed payment is still allocated', async () => {
  payment.status = 'completed';
  const res = await post('/api/v1/payments/3/allocate', { invoice_id: 50, amount: 100 });
  expect(res.status).toBe(201);
  expect(writes.some(sql => /INSERT INTO payment_allocations/.test(sql))).toBe(true);
});
