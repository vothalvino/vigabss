// =============================================================================
// TNB-24 — the WhatsApp webhook ignores ALLOW_UNSIGNED_WEBHOOKS when deployed
// =============================================================================
// The payment webhooks honoured ALLOW_UNSIGNED_WEBHOOKS only in development and
// test; the WhatsApp webhook honoured it in any NODE_ENV. With the flag set in
// production, WHATSAPP_PROVIDER=meta and no app secret, anyone could POST
// inbound messages from any phone and drive the bot (Wi-Fi resets, visits,
// tickets) for bound subscribers.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue([[]]), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/whatsappBotService', () => ({ handleInbound: jest.fn().mockResolvedValue(null) }));

const request = require('supertest');
const config = require('../src/config');
const { unsignedWebhooksAllowed } = require('../src/utils/unsignedWebhooks');

const saved = {};
beforeEach(() => {
  for (const k of ['NODE_ENV', 'ALLOW_UNSIGNED_WEBHOOKS', 'TWILIO_AUTH_TOKEN']) saved[k] = process.env[k];
  saved.provider = config.whatsapp.provider;
  saved.appSecret = config.whatsapp.appSecret;
  config.whatsapp.provider = 'meta';
  config.whatsapp.appSecret = '';
  process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (k === 'provider' || k === 'appSecret') continue;
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  config.whatsapp.provider = saved.provider;
  config.whatsapp.appSecret = saved.appSecret;
});

const inbound = {
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { messages: [{ from: '5215512345678', id: 'wamid.1', type: 'text', text: { body: 'reset wifi' } }] } }] }],
};

test.each(['production', 'staging', 'prod'])('NODE_ENV=%s rejects an unsigned payload despite the flag', async (env) => {
  process.env.NODE_ENV = env;
  const app = require('../src/app');
  const res = await request(app).post('/api/v1/whatsapp/webhook').send(inbound);
  expect(res.status).toBe(503);
  expect(res.body.error.code).toBe('WEBHOOK_NOT_CONFIGURED');
  expect(require('../src/services/whatsappBotService').handleInbound).not.toHaveBeenCalled();
});

test('the flag is honoured only in development and test, for both webhook kinds', () => {
  const allowedIn = (env) => { process.env.NODE_ENV = env; return unsignedWebhooksAllowed(); };
  expect(allowedIn('development')).toBe(true);
  expect(allowedIn('test')).toBe(true);
  expect(allowedIn('production')).toBe(false);
  expect(allowedIn('staging')).toBe(false);
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_UNSIGNED_WEBHOOKS = 'no';
  expect(unsignedWebhooksAllowed()).toBe(false);

  const fs = require('fs');
  const path = require('path');
  for (const file of ['whatsappWebhook.js', 'paymentWebhooks.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', file), 'utf8');
    expect(src).toMatch(/require\('\.\.\/utils\/unsignedWebhooks'\)/);
    expect(src).not.toMatch(/process\.env\.ALLOW_UNSIGNED_WEBHOOKS/);
  }
});

test('validateEnv reports the ignored flag outside development and test', () => {
  const logger = { warn: jest.fn(), error: jest.fn() };
  const env = config.env;
  config.env = 'staging';
  try {
    try { config.validateEnv(logger); } catch (_fatal) { /* other staging checks may be fatal here */ }
  } finally {
    config.env = env;
  }
  expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/ALLOW_UNSIGNED_WEBHOOKS is set but ignored/));
});
