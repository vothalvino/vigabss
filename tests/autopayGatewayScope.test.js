// =============================================================================
// WHK-12 — autopay completion on a per-gateway route uses that organization's
// gateway, and the session id is checked before it reaches a Stripe path
// =============================================================================
// completeEnrollment loaded metadata.gateway_id with no organization filter,
// so an event signed on org A's route could make the app call Stripe with org
// B's key, on a session id placed unencoded in the request path.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn(() => m) };
  return m;
});
const mockRetrieve = jest.fn(async () => ({ mode: 'setup', paymentMethod: null, customer: null }));
jest.mock('../src/services/paymentGatewayService', () => ({
  ...jest.requireActual('../src/services/paymentGatewayService'),
  retrieveStripeCheckoutSession: (...a) => mockRetrieve(...a),
}));

const db = require('../src/config/database');
const autopay = require('../src/services/autopayService');

const GW_A = { id: 1, provider: 'stripe', organization_id: 1, secret_key_encrypted: 'a' };
const GW_B = { id: 2, provider: 'stripe', organization_id: 2, secret_key_encrypted: 'b' };

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql, params) => {
    if (/WHERE id = \? AND provider = 'stripe'/.test(sql)) return [[params[0] === 2 ? GW_B : GW_A]];
    if (/WHERE organization_id = \? AND provider = 'stripe'/.test(sql)) return [[params[0] === 2 ? GW_B : GW_A]];
    return [[]];
  });
});

test('on org A\'s route, a metadata gateway from org B is ignored and A\'s gateway is used', async () => {
  await autopay.completeEnrollment({ sessionId: 'cs_test_1', organizationId: 1, metadata: { gateway_id: '2' } });
  expect(mockRetrieve).toHaveBeenCalledTimes(1);
  expect(mockRetrieve.mock.calls[0][0]).toBe(GW_A);
});

test('a metadata gateway of the same organization is still preferred', async () => {
  await autopay.completeEnrollment({ sessionId: 'cs_test_1', organizationId: 2, metadata: { gateway_id: '2' } });
  expect(mockRetrieve.mock.calls[0][0]).toBe(GW_B);
});

test('a session id that is not a checkout-session id never reaches a Stripe path', async () => {
  const { retrieveStripeCheckoutSession } = jest.requireActual('../src/services/paymentGatewayService');
  await expect(retrieveStripeCheckoutSession(GW_A, '../../v1/customers')).rejects.toMatchObject({ statusCode: 422 });
  await expect(retrieveStripeCheckoutSession(GW_A, 'cs_1?expand[]=x')).rejects.toMatchObject({ statusCode: 422 });
});
