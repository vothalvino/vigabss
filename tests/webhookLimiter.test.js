// =============================================================================
// WHK-07 — the webhook limiter counts failed deliveries only
// =============================================================================
// webhookLimiter allowed 100 requests per 15 minutes per source IP, counted
// before the signature check. Providers post from a few published IPs, so an
// autopay batch or a campaign's WhatsApp status callbacks went past it and the
// rest waited hours on the provider's backoff. The general API limiter also
// counted the same deliveries. Now verified (2xx) deliveries are free, and the
// API limiter leaves webhook paths to their own limiter.
// =============================================================================

const express = require('express');
const request = require('supertest');

function build() {
  let mod;
  jest.isolateModules(() => {
    process.env.RATE_LIMIT_WEBHOOK = '3';
    process.env.RATE_LIMIT_API = '2';
    mod = require('../src/middleware/rateLimit');
  });
  delete process.env.RATE_LIMIT_WEBHOOK;
  delete process.env.RATE_LIMIT_API;
  const { apiLimiter, webhookLimiter } = mod;
  const app = express();
  app.use('/api/', apiLimiter);
  app.use('/api/v1/payment-webhooks', webhookLimiter);
  app.use('/api/v1/whatsapp/webhook', webhookLimiter);
  // Stand-in for a provider route: 200 when the signature verifies, 401 otherwise.
  const handler = (req, res) => res.status(req.get('x-signature') === 'ok' ? 200 : 401).end();
  app.post('/api/v1/payment-webhooks/stripe', handler);
  app.post('/api/v1/whatsapp/webhook', handler);
  app.get('/api/v1/other', (req, res) => res.end());
  return app;
}

const deliver = (app, path, sig) => request(app).post(path).set('x-signature', sig);

test('verified deliveries are never throttled', async () => {
  const app = build();
  for (let i = 0; i < 10; i++) {
    const res = await deliver(app, '/api/v1/payment-webhooks/stripe', 'ok');
    expect(res.status).toBe(200);
  }
  for (let i = 0; i < 10; i++) {
    const res = await deliver(app, '/api/v1/whatsapp/webhook', 'ok');
    expect(res.status).toBe(200);
  }
});

test('failed deliveries still run into the limit', async () => {
  const app = build();
  for (let i = 0; i < 3; i++) {
    expect((await deliver(app, '/api/v1/payment-webhooks/stripe', 'bad')).status).toBe(401);
  }
  expect((await deliver(app, '/api/v1/payment-webhooks/stripe', 'bad')).status).toBe(429);
});

test('the general API limiter leaves webhook paths alone and still limits the rest', async () => {
  const app = build();
  for (let i = 0; i < 5; i++) {
    expect((await deliver(app, '/api/v1/payment-webhooks/stripe', 'ok')).status).toBe(200);
  }
  expect((await request(app).get('/api/v1/other')).status).toBe(200);
  expect((await request(app).get('/api/v1/other')).status).toBe(200);
  expect((await request(app).get('/api/v1/other')).status).toBe(429);
});
