// =============================================================================
// VigaBSS 5.0 — Payment mode: Stripe webhooks from the other side
// =============================================================================
// A Stripe event says whether it is live. One that does not match the
// install's INSTALL_MODE is refused before anything is stored.
// =============================================================================

const crypto = require('crypto');

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
  withTenantContext: jest.fn((_organizationId, fn) => fn()),
  withPrimaryContext: jest.fn(fn => fn()),
}));

const request = require('supertest');
const config = require('../src/config');
const db = require('../src/config/database');
const paymentGatewayService = require('../src/services/paymentGatewayService');
const app = require('../src/app');

const originalMode = config.install.mode;
beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { config.install.mode = originalMode; });

describe('a Stripe webhook from the other side', () => {
  const SECRET = ['whsec', 'exampleExampleExampleExampleExample'].join('_');
  const post = (event) => {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`, 'utf8').digest('hex');
    return request(app).post('/api/v1/payment-webhooks/stripe')
      .set('Content-Type', 'application/json').set('Stripe-Signature', `t=${t},v1=${v1}`).send(body);
  };
  const original = process.env.STRIPE_WEBHOOK_SECRET;
  beforeEach(() => { process.env.STRIPE_WEBHOOK_SECRET = SECRET; });
  afterEach(() => {
    if (original === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = original;
  });

  test('a live event on a test install is refused before anything is stored', async () => {
    config.install.mode = 'test';
    const res = await post({ id: 'evt_1', type: 'checkout.session.completed', livemode: true, data: { object: {} } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEBHOOK_MODE_MISMATCH');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a test event on a live install is refused', async () => {
    const res = await post({ id: 'evt_2', type: 'checkout.session.completed', livemode: false, data: { object: {} } });
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('an event from the right side is processed', async () => {
    const spy = jest.spyOn(paymentGatewayService, 'handleWebhookEvent').mockResolvedValue({ status: 'ignored' });
    const res = await post({ id: 'evt_3', type: 'customer.created', livemode: true, data: { object: {} } });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
