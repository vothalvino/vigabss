// =============================================================================
// DAL-04 — allocation paths lock the payment and invoices before summing
// =============================================================================
// The over-allocation triggers read payments.amount, invoices.total and the
// allocation sums without locks, and Payment.allocate was an autocommit INSERT
// that relied on them. allocate-auto summed the payment's allocations before
// locking the invoices, which fixed its REPEATABLE READ snapshot first, and
// MySQL does not lock subquery rows for an outer FOR UPDATE. Two concurrent
// allocations could both pass: one payment settled two invoices, or one
// invoice collected two payments.
//
// Every path now takes the payment lock, then a plain locking read of the
// invoices, before the first read that sums allocations. A real two-session
// race needs MySQL; these tests pin the statement order that prevents it.
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

const db = require('../src/config/database');
const { mockTxConnection } = require('./fixtures/mockTxConnection');
const app = require('../src/app');

const PAYMENT = { id: 3, organization_id: 1, client_id: 10, amount: '100.00', currency: 'MXN', status: 'completed' };
const INVOICE = { id: 50, organization_id: 1, client_id: 10, total: '100.00', status: 'issued', currency: 'MXN', issue_date: '2026-10-01' };

const INVOICE_LOCK = /^SELECT id FROM invoices WHERE organization_id <=> \? AND \(.*\) ORDER BY id FOR UPDATE$/;
const SUMS_ALLOCATIONS = /SUM\((pa\.)?amount\)/;

let conn;
function wire({ balanceDue = '100.00', allocated = '0' } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM payments WHERE id = \?/.test(sql)) return [[{ ...PAYMENT }]];
    if (INVOICE_LOCK.test(sql)) return [[]];
    if (/AS balance_due/.test(sql)) return [[{ ...INVOICE, balance_due: balanceDue }]];
    if (/FROM invoices WHERE id IN/.test(sql)) return [[{ ...INVOICE }, { ...INVOICE, id: 51 }]];
    if (/FROM invoices WHERE id = \?/.test(sql)) return [[{ ...INVOICE }]];
    if (/AS allocated FROM payment_allocations/.test(sql)) return [[{ allocated }]];
    if (/FROM payment_allocations WHERE payment_id = \? AND invoice_id = \?/.test(sql)) return [[{ id: 7, payment_id: 3, invoice_id: 50, amount: '100.00' }]];
    if (/total_allocated/.test(sql)) return [[{ total_allocated: '0' }]];
    if (/^\s*INSERT/.test(sql)) return [{ insertId: 77, affectedRows: 1 }];
    if (/^\s*(UPDATE|DELETE)/.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
  conn = mockTxConnection(db);
}

// Index of the first transaction statement matching `re`.
const at = (re) => conn.execute.mock.calls.findIndex(([sql]) => re.test(sql.trim()));

function expectLockedBeforeSums() {
  const paymentLock = at(/FROM payments WHERE id = \? .*FOR UPDATE/);
  const invoiceLock = at(INVOICE_LOCK);
  const firstSum = at(SUMS_ALLOCATIONS);
  expect(paymentLock).toBe(0);
  expect(invoiceLock).toBeGreaterThan(paymentLock);
  expect(firstSum).toBeGreaterThan(invoiceLock);
}

beforeEach(() => jest.clearAllMocks());

describe('POST /payments/:id/allocate', () => {
  test('runs on one transaction, payment then invoice locked before any sum', async () => {
    wire();
    const res = await request(app).post('/api/v1/payments/3/allocate').send({ invoice_id: 50, amount: 100 });
    expect(res.status).toBe(201);
    expectLockedBeforeSums();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.execute.mock.calls.some(([sql]) => /INSERT INTO payment_allocations/.test(sql))).toBe(true);
  });

  test('refuses more than the invoice still owes, before inserting', async () => {
    wire({ balanceDue: '40.00' });
    const res = await request(app).post('/api/v1/payments/3/allocate').send({ invoice_id: 50, amount: 100 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OVER_ALLOCATION');
    expect(conn.execute.mock.calls.some(([sql]) => /INSERT INTO payment_allocations/.test(sql))).toBe(false);
    expect(conn.rollback).toHaveBeenCalled();
  });

  test('refuses more than the payment has left, before inserting', async () => {
    wire({ allocated: '80.00' });
    const res = await request(app).post('/api/v1/payments/3/allocate').send({ invoice_id: 50, amount: 30 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OVER_ALLOCATION');
    expect(conn.execute.mock.calls.some(([sql]) => /INSERT INTO payment_allocations/.test(sql))).toBe(false);
  });
});

test('POST /payments/:id/allocate-auto locks the client\'s invoices before summing the payment', async () => {
  wire();
  const res = await request(app).post('/api/v1/payments/3/allocate-auto').send({});
  expect(res.status).toBeLessThan(300);
  expectLockedBeforeSums();
  expect(conn.execute.mock.calls[at(INVOICE_LOCK)][1]).toEqual([1, 10]);
});

test('POST /payments/:id/reallocate locks the payment and both invoices before reading allocations', async () => {
  wire();
  await request(app).post('/api/v1/payments/3/reallocate').send({ from_invoice_id: 50, to_invoice_id: 51 });
  const paymentLock = at(/FROM payments WHERE id = \? .*FOR UPDATE/);
  const invoiceLock = at(INVOICE_LOCK);
  expect(paymentLock).toBe(0);
  expect(invoiceLock).toBe(1);
  expect(conn.execute.mock.calls[invoiceLock][1]).toEqual([1, 50, 51]);
  expect(at(/FROM payment_allocations/)).toBeGreaterThan(invoiceLock);
});

test('gateway reconciliation locks the invoices before its first plain read', async () => {
  const paymentGatewayService = require('../src/services/paymentGatewayService');
  db.query.mockImplementation(async (sql) => {
    if (/FROM payment_transactions WHERE id = \? FOR UPDATE/.test(sql)) {
      return [[{ id: 9, organization_id: 1, client_id: 10, invoice_id: 50, amount: '100.00', currency: 'MXN', gateway_status: 'succeeded', payment_id: null, payment_gateway_id: 2 }]];
    }
    if (/AS balance_due/.test(sql)) return [[{ ...INVOICE, balance_due: '100.00' }]];
    if (/^\s*INSERT/.test(sql)) return [{ insertId: 70, affectedRows: 1 }];
    return [[]];
  });
  conn = mockTxConnection(db);
  await paymentGatewayService.reconcilePayment(9);
  const txLock = at(/FROM payment_transactions WHERE id = \? FOR UPDATE/);
  const invoiceLock = at(INVOICE_LOCK);
  expect(txLock).toBe(0);
  expect(invoiceLock).toBe(1);
  expect(conn.execute.mock.calls[invoiceLock][1]).toEqual([1, 50]);
});

test('a payment-plan installment locks its invoice before reading the payment\'s allocations', async () => {
  const paymentPlanService = require('../src/services/paymentPlanService');
  db.query.mockImplementation(async (sql) => {
    if (/FROM payment_plans WHERE id = \?/.test(sql)) return [[{ id: 1, organization_id: 1, client_id: 10, status: 'active' }]];
    if (/FROM payment_plan_installments WHERE plan_id = \? AND sequence = \?/.test(sql)) return [[{ id: 4, plan_id: 1, sequence: 1, amount: '100.00', invoice_id: 50, status: 'pending' }]];
    if (/FROM payments WHERE id = \?/.test(sql)) return [[{ ...PAYMENT }]];
    if (/AS allocated/.test(sql)) return [[{ allocated: '0' }]];
    if (/AS balance_due/.test(sql)) return [[{ ...INVOICE, balance_due: '100.00' }]];
    if (/COUNT\(\*\) AS remaining/.test(sql)) return [[{ remaining: 1 }]];
    return [[]];
  });
  conn = mockTxConnection(db);
  await paymentPlanService.payInstallment(1, 1, 3, 1);
  const invoiceLock = at(INVOICE_LOCK);
  expect(invoiceLock).toBeGreaterThan(at(/FROM payments WHERE id = \? .*FOR UPDATE/));
  expect(invoiceLock).toBeLessThan(at(/WHERE paid_payment_id = \?/));
  expect(invoiceLock).toBeLessThan(at(SUMS_ALLOCATIONS));
});
