'use strict';
// =============================================================================
// BIL-28 — one guarded writer for payment allocations
// =============================================================================
// Six code paths inserted payment_allocations rows, each with its own checks.
// POST /payments/:id/allocate checked the organization but not that the
// invoice was the payment's client's, so one client's payment could settle
// another client's invoice; nothing anywhere compared currencies. Every
// writer now goes through paymentAllocationService.applyAllocation.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn() }));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const { mockTxConnection } = require('./fixtures/mockTxConnection');
const { allocationRefusal, applyAllocation } = require('../src/services/paymentAllocationService');
const app = require('../src/app');

const AUTH = 'Bearer ' + jwt.sign({ sub: 1, email: 'a@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const PAYMENT = { id: 1, organization_id: 1, client_id: 5, currency: 'MXN', amount: '500.00', status: 'completed' };
const INVOICE = { id: 9, organization_id: 1, client_id: 5, currency: 'MXN', status: 'issued', total: '500.00' };

function srcFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? srcFiles(p) : (p.endsWith('.js') ? [p] : []);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTxConnection(db);
  User.findById.mockResolvedValue({ id: 1, email: 'a@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

test('only paymentAllocationService inserts allocation rows', () => {
  const root = path.join(__dirname, '..', 'src');
  const writers = srcFiles(root)
    .filter((f) => /INSERT INTO payment_allocations/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(root, f));
  expect(writers).toEqual([path.join('services', 'paymentAllocationService.js')]);
});

describe('allocationRefusal', () => {
  test('the payment\'s own payable invoice in its currency is allowed', () => {
    expect(allocationRefusal(PAYMENT, INVOICE)).toBeNull();
  });

  test.each([
    ['another client\'s invoice', { client_id: 6 }, 'CROSS_CLIENT_ALLOCATION'],
    ['an invoice in another currency', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
    ['another organization\'s invoice', { organization_id: 2 }, 'NOT_FOUND'],
    ['a draft invoice', { status: 'draft' }, 'INVOICE_NOT_PAYABLE'],
    ['a void invoice', { status: 'void' }, 'INVOICE_NOT_PAYABLE'],
  ])('%s is refused', (_label, change, code) => {
    expect(allocationRefusal(PAYMENT, { ...INVOICE, ...change })).toMatchObject({ code });
  });

  test('group billing may settle a member\'s invoice, but not in another currency', () => {
    expect(allocationRefusal(PAYMENT, { ...INVOICE, client_id: 6 }, { anyClient: true })).toBeNull();
    expect(allocationRefusal(PAYMENT, { ...INVOICE, client_id: 6, currency: 'USD' }, { anyClient: true }))
      .toMatchObject({ code: 'CURRENCY_MISMATCH' });
  });
});

test('applyAllocation refuses before inserting and maps the guard trigger', async () => {
  const exec = jest.fn();
  await expect(applyAllocation(exec, { payment: PAYMENT, invoice: { ...INVOICE, client_id: 6 }, amount: 10 }))
    .rejects.toMatchObject({ statusCode: 422, code: 'CROSS_CLIENT_ALLOCATION' });
  expect(exec).not.toHaveBeenCalled();

  exec.mockRejectedValueOnce(Object.assign(new Error('exceeds'), { sqlState: '45000', errno: 1644 }));
  await expect(applyAllocation(exec, { payment: PAYMENT, invoice: INVOICE, amount: 10 }))
    .rejects.toMatchObject({ statusCode: 422, code: 'OVER_ALLOCATION' });
});

test('POST /payments/:id/allocate refuses another client\'s invoice in the same organization', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/FROM payments WHERE id = \?/.test(sql)) return [[PAYMENT]];
    if (/^SELECT \* FROM invoices WHERE id = \?/.test(sql)) return [[{ ...INVOICE, client_id: 6 }]];
    return [[]];
  });

  const res = await request(app)
    .post('/api/v1/payments/1/allocate')
    .set('Authorization', AUTH)
    .send({ invoice_id: 9, amount: 100 });

  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe('CROSS_CLIENT_ALLOCATION');
  expect(db.query.mock.calls.some(([sql]) => /INSERT INTO payment_allocations/.test(sql))).toBe(false);
});
