// =============================================================================
// VigaBSS 5.0 — Install mode (INSTALL_MODE: live or test)
// =============================================================================
// One switch for the install decides whether anything real happens. A Stripe
// key or event from the other side is refused, a Stripe gateway's environment
// is read from its key, and the fiscal (SAT) environment follows the same
// switch; nobody chooses any of it.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/PaymentGateway');
jest.mock('../src/models/User');

const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const PaymentGateway = require('../src/models/PaymentGateway');
const User = require('../src/models/User');
const paymentGatewayService = require('../src/services/paymentGatewayService');
const { stripeKeyMode, installPaymentMode, environmentForMode, fiscalEnvironment, isTestInstall } = require('../src/utils/installMode');
const app = require('../src/app');

const token = jwt.sign({ sub: 1, email: 'admin@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const TEST_KEY = 'sk_test_exampleExampleExample';
const LIVE_KEY = 'sk_live_exampleExampleExample';
const row = { id: 5, organization_id: 1, name: 'Stripe', provider: 'stripe', environment: 'production', secret_key_encrypted: 'x', status: 'active' };

const send = (method, path, body) => {
  const req = request(app)[method](path).set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1');
  return body === undefined ? req : req.send(body);
};

const originalMode = config.install.mode;
beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockResolvedValue({ id: 1, email: 'admin@test.com', status: 'active', role: 'admin', organization_id: 1 });
  PaymentGateway.create.mockImplementation(async data => ({ ...row, ...data }));
  PaymentGateway.update.mockImplementation(async (_id, data) => ({ ...row, ...data }));
  PaymentGateway.findByIdOrFail.mockResolvedValue(row);
});
afterEach(() => { config.install.mode = originalMode; });

describe('reading the mode', () => {
  test('a Stripe key says which side it is on', () => {
    expect(stripeKeyMode(TEST_KEY)).toBe('test');
    expect(stripeKeyMode(LIVE_KEY)).toBe('live');
    expect(stripeKeyMode('rk_test_abc')).toBe('test');
    expect(stripeKeyMode('  rk_live_abc ')).toBe('live');
    for (const notAKey of ['pk_live_abc', 'whsec_abc', 'sk_abc', '', null, undefined]) {
      expect(stripeKeyMode(notAKey)).toBeNull();
    }
  });

  test('the install is live unless it is explicitly test', () => {
    expect(installPaymentMode()).toBe('live');
    config.install.mode = 'test';
    expect(installPaymentMode()).toBe('test');
    config.install.mode = 'anything';
    expect(installPaymentMode()).toBe('live');
    expect(environmentForMode('test')).toBe('sandbox');
    expect(environmentForMode('live')).toBe('production');
    // The fiscal (SAT) environment follows the same switch.
    expect(fiscalEnvironment()).toBe('production');
    config.install.mode = 'test';
    expect(fiscalEnvironment()).toBe('sandbox');
    expect(isTestInstall()).toBe(true);
  });

  test('the signed-in user carries the install mode, for the DEV MODE badge', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
    expect(source).toMatch(/install_mode: installMode\(\),/);
  });
});

describe('saving a Stripe gateway', () => {
  test('a live install refuses a test key and stores nothing', async () => {
    const res = await send('post', '/api/v1/payment-gateways', { name: 'Stripe', provider: 'stripe', secret_key: TEST_KEY });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/only Stripe live keys/);
    expect(JSON.stringify(res.body)).not.toContain(TEST_KEY);
    expect(PaymentGateway.create).not.toHaveBeenCalled();
  });

  test('a test install refuses a live key and stores nothing', async () => {
    config.install.mode = 'test';
    const res = await send('post', '/api/v1/payment-gateways', { name: 'Stripe', provider: 'stripe', secret_key: LIVE_KEY });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/test mode/);
    expect(PaymentGateway.create).not.toHaveBeenCalled();
  });

  test('the environment comes from the key, whatever the request says', async () => {
    config.install.mode = 'test';
    const res = await send('post', '/api/v1/payment-gateways', { name: 'Stripe', provider: 'stripe', environment: 'production', secret_key: TEST_KEY });
    expect(res.status).toBe(201);
    expect(PaymentGateway.create.mock.calls[0][0].environment).toBe('sandbox');

    config.install.mode = 'live';
    await send('post', '/api/v1/payment-gateways', { name: 'Stripe', provider: 'stripe', environment: 'sandbox', secret_key: LIVE_KEY });
    expect(PaymentGateway.create.mock.calls[1][0].environment).toBe('production');
  });

  test('something that is not a Stripe secret key is refused', async () => {
    const res = await send('post', '/api/v1/payment-gateways', { name: 'Stripe', provider: 'stripe', secret_key: 'pk_live_publishable' });
    expect(res.status).toBe(422);
    expect(PaymentGateway.create).not.toHaveBeenCalled();
  });

  test('an edit that replaces the key is checked against the stored provider', async () => {
    const res = await send('put', '/api/v1/payment-gateways/5', { secret_key: TEST_KEY });
    expect(res.status).toBe(422);
    expect(PaymentGateway.update).not.toHaveBeenCalled();
  });

  test('an edit without a new key cannot move the environment label', async () => {
    const res = await send('put', '/api/v1/payment-gateways/5', { name: 'Renamed', environment: 'sandbox' });
    expect(res.status).toBe(200);
    expect(PaymentGateway.update.mock.calls[0][1]).not.toHaveProperty('environment');
  });

  test('other providers keep the label they are given and any key', async () => {
    const res = await send('post', '/api/v1/payment-gateways', { name: 'Conekta', provider: 'conekta', environment: 'sandbox', secret_key: 'key_exampleExample' });
    expect(res.status).toBe(201);
    expect(PaymentGateway.create.mock.calls[0][0].environment).toBe('sandbox');
  });
});

describe('testing a gateway connection', () => {
  const stored = provider => db.query.mockResolvedValueOnce([[{ id: 5, provider, secret_key_encrypted: TEST_KEY }]]);

  test('reads the Stripe balance with the stored key and reports the key\'s side', async () => {
    stored('stripe');
    const requestFn = jest.fn().mockResolvedValue({ object: 'balance', livemode: false });
    expect(await paymentGatewayService.testGatewayConnection(5, 1, { request: requestFn })).toEqual({ ok: true, mode: 'test' });
    expect(requestFn).toHaveBeenCalledWith(TEST_KEY, 'GET', '/v1/balance', null, 15000);
    expect(db.query.mock.calls[0][1]).toEqual([5, 1]);
  });

  test('a refused key is a result, not an error, and does not echo the key', async () => {
    stored('stripe');
    const requestFn = jest.fn().mockRejectedValue(new Error('The payment provider refused the request (HTTP 401)'));
    const result = await paymentGatewayService.testGatewayConnection(5, 1, { request: requestFn });
    expect(result).toEqual({ ok: false, error: 'The payment provider refused the request (HTTP 401)' });
  });

  test('other providers are not called', async () => {
    stored('conekta');
    const requestFn = jest.fn();
    expect((await paymentGatewayService.testGatewayConnection(5, 1, { request: requestFn })).ok).toBe(false);
    expect(requestFn).not.toHaveBeenCalled();
  });

  test('a gateway of another organization is not found', async () => {
    db.query.mockResolvedValueOnce([[]]);
    await expect(paymentGatewayService.testGatewayConnection(5, 2)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('POST /payment-gateways/:id/test returns the result', async () => {
    const spy = jest.spyOn(paymentGatewayService, 'testGatewayConnection').mockResolvedValue({ ok: true, mode: 'live' });
    const res = await send('post', '/api/v1/payment-gateways/5/test');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true, mode: 'live' });
    expect(spy).toHaveBeenCalledWith('5', 1);
    spy.mockRestore();
  });
});
