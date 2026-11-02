// =============================================================================
// WHK-15 — machine-to-machine secrets are checked at boot, and the enabled
// shared-secret endpoints are logged
// =============================================================================
// validateEnv checked JWT, ENCRYPTION_KEY, WireGuard, WhatsApp and DB only.
// RADIUS_ACCOUNTING_SECRET, PPPOE_EVENTS_SECRET, FIRERELAY_TUNNEL_SECRET,
// STRIPE_WEBHOOK_SECRET and CONEKTA_WEBHOOK_KEY were accepted at any length or
// format, so a collector endpoint could run on a guessable secret.
// =============================================================================
'use strict';

const crypto = require('node:crypto');
const config = require('../src/config');

const KEYS = ['RADIUS_ACCOUNTING_SECRET', 'PPPOE_EVENTS_SECRET', 'FIRERELAY_TUNNEL_SECRET',
  'STRIPE_WEBHOOK_SECRET', 'CONEKTA_WEBHOOK_KEY'];
let saved;
beforeEach(() => { saved = { env: config.env, vars: Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) }; KEYS.forEach((k) => delete process.env[k]); });
afterEach(() => {
  config.env = saved.env;
  for (const [k, v] of Object.entries(saved.vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const logger = () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() });

test.each([['short'], ['changeme'], ['a'.repeat(40)]])('%p is weak', (value) => {
  expect(config.weakSecretReason(value)).not.toBeNull();
});

test('a random 64-hex secret is fine', () => {
  expect(config.weakSecretReason(crypto.randomBytes(32).toString('hex'))).toBeNull();
});

test('a weak accounting secret is fatal in production', () => {
  config.env = 'production';
  process.env.RADIUS_ACCOUNTING_SECRET = 'radius123';
  expect(() => config.validateEnv(logger())).toThrow(/RADIUS_ACCOUNTING_SECRET is shorter than 32/);
});

test('an invalid Conekta key is fatal in production', () => {
  config.env = 'production';
  process.env.CONEKTA_WEBHOOK_KEY = 'not-a-pem';
  expect(() => config.validateEnv(logger())).toThrow(/CONEKTA_WEBHOOK_KEY is not a valid public key PEM/);
});

test('outside production a weak secret is a warning, and the live endpoints are logged', () => {
  config.env = 'development';
  process.env.PPPOE_EVENTS_SECRET = 'short';
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CONEKTA_WEBHOOK_KEY = publicKey.export({ type: 'spki', format: 'pem' }).replace(/\n/g, '\\n');
  const log = logger();
  config.validateEnv(log);
  expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/PPPOE_EVENTS_SECRET is shorter/));
  const endpoints = log.info.mock.calls.find(([o]) => o && o.sharedSecretEndpoints)[0].sharedSecretEndpoints;
  expect(endpoints).toEqual(expect.arrayContaining([
    expect.stringMatching(/pppoe\/events/), expect.stringMatching(/payment-webhooks\/conekta/),
  ]));
});
