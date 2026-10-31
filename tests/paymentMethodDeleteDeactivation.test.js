// =============================================================================
// DAL-01 — deleting a payment gateway or a saved card stops it being charged
// =============================================================================
// Both models soft-delete, which only set deleted_at: status stayed 'active',
// and every money path (checkout, autopay, retries) filtered on status alone,
// so the next autopay run or retry still charged through the deleted row.
// Deleting is now a deactivation that also cancels the scheduled retries.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('../src/models/PaymentGateway');
jest.mock('../src/models/RecurringPaymentProfile');
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const PaymentGateway = require('../src/models/PaymentGateway');
const RecurringPaymentProfile = require('../src/models/RecurringPaymentProfile');
const User = require('../src/models/User');
const app = require('../src/app');

const adminToken = jwt.sign(
  { sub: 1, email: 'admin@test.com', role: 'admin', orgId: 1 },
  config.jwt.secret,
  { expiresIn: '1h' },
);

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue([{ affectedRows: 1 }]);
  User.findById.mockResolvedValue({
    id: 1, email: 'admin@test.com', status: 'active', role: 'admin', organization_id: 1,
  });
});

function writes(pattern) {
  return db.query.mock.calls.filter(([sql]) => pattern.test(sql));
}

test('DELETE /payment-gateways/:id deactivates the gateway and cancels retries on its cards', async () => {
  PaymentGateway.findByIdOrFail.mockResolvedValue({ id: 5, organization_id: 1, status: 'active' });
  PaymentGateway.delete.mockResolvedValue(true);

  const res = await request(app)
    .delete('/api/v1/payment-gateways/5')
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBeLessThan(300);
  const [deactivate] = writes(/UPDATE payment_gateways SET status = 'inactive'/);
  expect(deactivate).toBeDefined();
  expect(deactivate[1]).toEqual([5, 1]);
  const [cancel] = writes(/UPDATE payment_retries pr/);
  expect(cancel[0]).toContain('rp.payment_gateway_id = ?');
  expect(cancel[0]).toContain("pr.status = 'cancelled'");
  expect(cancel[1]).toEqual([5, 1]);
  expect(PaymentGateway.delete).toHaveBeenCalled();
});

test('DELETE /recurring-payment-profiles/:id revokes the card and cancels its retries', async () => {
  RecurringPaymentProfile.findByIdOrFail.mockResolvedValue({ id: 7, organization_id: 1, status: 'active' });
  RecurringPaymentProfile.delete.mockResolvedValue(true);

  const res = await request(app)
    .delete('/api/v1/recurring-payment-profiles/7')
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBeLessThan(300);
  const [revoke] = writes(/UPDATE recurring_payment_profiles SET status = 'revoked'/);
  expect(revoke[1]).toEqual([7, 1]);
  const [cancel] = writes(/UPDATE payment_retries/);
  expect(cancel[0]).toContain('recurring_profile_id = ?');
  expect(cancel[1]).toEqual([7]);
});
