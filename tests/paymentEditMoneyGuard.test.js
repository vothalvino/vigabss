// =============================================================================
// BIL-19 — editing a payment's amount or status keeps the money consistent
// =============================================================================
// PUT/PATCH /payments/:id used the generic update with no money guard.
// Lowering an allocated 500 payment to 1.00, or marking it refunded, left its
// allocations live, the invoice 'paid' and the ledger credit in place, while
// the computed balance ignored the non-completed payment.
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
  orgScope: (req, _res, next) => { req.orgId = 5; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const { mockTxConnection, txSql } = require('./fixtures/mockTxConnection');
const app = require('../src/app');

const PAYMENT = { id: 70, organization_id: 5, client_id: 42, amount: '500.00', currency: 'MXN', status: 'completed', reference_number: 'R1' };

let conn;
function wire({ allocated }) {
  db.query.mockImplementation(async (sql) => {
    if (/SUM\(amount\), 0\) AS allocated FROM payment_allocations/.test(sql)) return [[{ allocated }]];
    if (/FROM `?payments`?/.test(sql)) return [[PAYMENT]];
    if (/^\s*(UPDATE|DELETE|INSERT)/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
    return [[]];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  conn = mockTxConnection(db);
});

const paymentUpdates = () => txSql(conn).filter((sql) => /^UPDATE `?payments`?/.test(sql));
const ledgerCalls = () => conn.execute.mock.calls.filter(([sql]) => /client_balance_ledger/.test(sql));

describe('PATCH /api/v1/payments/:id', () => {
  it('refuses an amount below what is allocated', async () => {
    wire({ allocated: '500.00' });
    const res = await request(app).patch('/api/v1/payments/70').send({ amount: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_AMOUNT_BELOW_ALLOCATED');
    expect(paymentUpdates()).toHaveLength(0);
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it.each(['refunded', 'cancelled', 'failed', 'pending'])('refuses moving an allocated payment to %s', async (status) => {
    wire({ allocated: '200.00' });
    const res = await request(app).patch('/api/v1/payments/70').send({ status });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_HAS_ALLOCATIONS');
    expect(paymentUpdates()).toHaveLength(0);
  });

  it('raises the amount and re-records the ledger credit at the new amount, in the transaction', async () => {
    wire({ allocated: '500.00' });
    const res = await request(app).patch('/api/v1/payments/70').send({ amount: 650 });
    expect(res.status).toBe(200);
    const [del, ins] = ledgerCalls();
    expect(del[0]).toMatch(/^\s*DELETE FROM client_balance_ledger/);
    expect(del[1]).toEqual([70]);
    expect(ins[0]).toMatch(/INSERT INTO client_balance_ledger/);
    expect(ins[1]).toContain(650);
  });

  it('cancelling an unallocated payment drops its ledger credit', async () => {
    wire({ allocated: '0' });
    const res = await request(app).patch('/api/v1/payments/70').send({ status: 'cancelled' });
    expect(res.status).toBe(200);
    const calls = ledgerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatch(/DELETE FROM client_balance_ledger/);
  });

  it('a non-money edit leaves allocations and the ledger alone', async () => {
    wire({ allocated: '500.00' });
    const res = await request(app).patch('/api/v1/payments/70').send({ reference_number: 'R2' });
    expect(res.status).toBe(200);
    expect(ledgerCalls()).toHaveLength(0);
  });
});

it('PUT is guarded too', async () => {
  wire({ allocated: '500.00' });
  const res = await request(app).put('/api/v1/payments/70').send({ amount: 1 });
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe('PAYMENT_AMOUNT_BELOW_ALLOCATED');
});
