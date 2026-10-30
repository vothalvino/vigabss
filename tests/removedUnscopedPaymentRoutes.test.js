// =============================================================================
// VigaBSS 5.0 — Removed unscoped payment routes
// =============================================================================
// POST /checkout/recurring/:id/charge charged any organization's stored card
// by profile id and charged again on every call; POST /billing/allocate-payment
// allocated a payment to any organization's invoice and marked it paid. Neither
// had a UI caller, so both were removed. Even a global-access operator must now
// get 404 and no charge or allocation may run.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('../src/services/orgPrincipalService', () => ({
  resolveOrgPrincipal: jest.fn(async (_user, organizationId) => ({
    authorizationRole: 'admin',
    membershipRole: 'admin',
    organizationId: Number(organizationId),
    isInstallOperator: true,
    isSuperAdmin: true,
    hasGlobalOrganizationAccess: true,
  })),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const checkoutService = require('../src/services/checkoutService');
const app = require('../src/app');

const token = () => jwt.sign(
  { sub: 1, email: 'operator@isp.example', role: 'admin', orgId: 1 },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql) => {
    if (/FROM `?users`?\b/.test(sql)) {
      return [[{ id: 1, email: 'operator@isp.example', role: 'admin', status: 'active', organization_id: 1 }]];
    }
    // An own-org payment exists, so the old allocator would have proceeded.
    if (/FROM payments WHERE id = \?/.test(sql)) return [[{ id: 1, organization_id: 1, client_id: 3, amount: '100.00' }]];
    return [[]];
  });
});

afterEach(() => jest.restoreAllMocks());

test('POST /api/v1/checkout/recurring/:id/charge no longer exists and charges nothing', async () => {
  const charge = jest.spyOn(checkoutService, 'chargeRecurringProfile');
  const res = await request(app)
    .post('/api/v1/checkout/recurring/5/charge')
    .set('Authorization', `Bearer ${token()}`)
    .send({});
  expect(res.status).toBe(404);
  expect(charge).not.toHaveBeenCalled();
});

test('POST /api/v1/billing/allocate-payment no longer exists and writes nothing', async () => {
  const res = await request(app)
    .post('/api/v1/billing/allocate-payment')
    .set('Authorization', `Bearer ${token()}`)
    .send({ payment_id: 1, allocations: [{ invoice_id: 99, amount: 100 }] });
  expect(res.status).toBe(404);
  expect(db.getConnection).not.toHaveBeenCalled();
  expect(db.query.mock.calls.some(([sql]) => /payment_allocations|UPDATE invoices/.test(sql))).toBe(false);
});
