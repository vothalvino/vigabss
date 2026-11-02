// =============================================================================
// FE-19 — invoice items carry their tax rate, an invoice carries its billing
// period, and gateway transactions filter by payment and name the gateway
// =============================================================================
// /invoices/:id/items was SELECT * FROM invoice_items, which has only
// tax_rate_id, so the line tax % was always blank. invoices has no period
// columns, so the period never showed. PaymentTransaction's fillable named
// columns the table does not have and lacked client_id, so the payments
// drawer's filter was dropped and it listed the organization's first 50 rows.
// =============================================================================
'use strict';

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin', organizationId: 1 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/database');
const Invoice = require('../src/models/Invoice');

beforeEach(() => jest.clearAllMocks());

test("invoice items include each line's effective tax rate", async () => {
  db.query.mockResolvedValue([[{ id: 1, tax_rate: '0.1600' }]]);
  await Invoice.getItems(5, 1);
  const [sql] = db.query.mock.calls[0];
  expect(sql).toMatch(/COALESCE\(tr\.rate, i\.tax_rate\) AS tax_rate/);
  expect(sql).toMatch(/LEFT JOIN tax_rates tr ON tr\.id = ii\.tax_rate_id/);
});

test('GET /invoices/:id includes the billing period', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/FROM billing_periods/.test(sql)) return [[{ period_start: '2026-10-01', period_end: '2026-10-31' }]];
    return [[{ id: 5, organization_id: 1, status: 'issued' }]];
  });
  const res = await request(app).get('/api/v1/invoices/5');
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ id: 5, period_start: '2026-10-01', period_end: '2026-10-31' });
});

test('payment transactions filter by payment_id and carry the gateway name', async () => {
  db.query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(sql) ? [[{ total: 0 }]] : [[]]));
  const res = await request(app).get('/api/v1/payment-transactions?payment_id=12&client_id=7');
  expect(res.status).toBe(200);
  const [sql, params] = db.query.mock.calls[0];
  expect(sql).toMatch(/pg\.name AS gateway_name/);
  expect(sql).toMatch(/pt\.client_id = \? AND pt\.payment_id = \?/);
  expect(sql).not.toMatch(/raw_request|raw_response|webhook_payload/);
  expect(params).toEqual([1, '7', '12']);
});
