// =============================================================================
// TNA-23 — the campaign delivery webhook authenticates and counts once
// =============================================================================
// It was open unless WEBHOOK_DELIVERY_SECRET happened to be set, compared the
// secret with !==, never checked Twilio's signature, echoed err.message, and
// counted every replay of the same status.

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const db = require('../src/config/database');
const campaignService = require('../src/services/campaignService');
const router = require('../src/routes/communicationDelivery');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/communication', router);

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; jest.restoreAllMocks(); jest.clearAllMocks(); });

describe('authentication', () => {
  test('with no secret configured the endpoint is closed in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.WEBHOOK_DELIVERY_SECRET;
    delete process.env.TWILIO_AUTH_TOKEN;
    const spy = jest.spyOn(campaignService, 'handleDeliveryCallback');
    const res = await request(app).post('/communication/delivery-webhook').send({ provider_message_id: 'm1', status: 'delivered' });
    expect(res.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });

  test('a wrong secret is 401', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WEBHOOK_DELIVERY_SECRET = 's3cret-value';
    const res = await request(app).post('/communication/delivery-webhook')
      .set('X-Webhook-Secret', 's3cret-valuX').send({ provider_message_id: 'm1', status: 'delivered' });
    expect(res.status).toBe(401);
  });

  test('a Twilio callback is accepted on a valid X-Twilio-Signature', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TWILIO_AUTH_TOKEN = 'twilio-token';
    process.env.WHATSAPP_WEBHOOK_PUBLIC_URL = 'https://isp.example';
    const body = { MessageSid: 'SM1', MessageStatus: 'delivered' };
    const data = Object.keys(body).sort().reduce((acc, k) => acc + k + body[k], 'https://isp.example/communication/delivery-webhook');
    const signature = crypto.createHmac('sha1', 'twilio-token').update(data).digest('base64');
    const spy = jest.spyOn(campaignService, 'handleDeliveryCallback').mockResolvedValue({ updated: true });

    const res = await request(app).post('/communication/delivery-webhook')
      .type('form').set('X-Twilio-Signature', signature).send(body);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('SM1', 'delivered', expect.anything());

    const forged = await request(app).post('/communication/delivery-webhook')
      .type('form').set('X-Twilio-Signature', 'AAAA').send(body);
    expect(forged.status).toBe(401);
  });

  test('a processing error is not echoed', async () => {
    process.env.NODE_ENV = 'test';
    jest.spyOn(campaignService, 'handleDeliveryCallback').mockRejectedValue(new Error('ER_ACCESS_DENIED for user db@10.0.0.4'));
    const res = await request(app).post('/communication/delivery-webhook').send({ provider_message_id: 'm1', status: 'delivered' });
    expect(JSON.stringify(res.body)).not.toMatch(/ER_ACCESS_DENIED|10\.0\.0\.4/);
  });
});

describe('forward-only, counted once', () => {
  const wire = (status, affected = 1) => db.query.mockImplementation(async (sql) => {
    if (/SELECT \* FROM campaign_messages/.test(sql)) return [[{ id: 4, campaign_id: 2, status }]];
    if (/UPDATE campaign_messages/.test(sql)) return [{ affectedRows: affected }];
    return [{ affectedRows: 1 }];
  });
  const counted = () => db.query.mock.calls.filter(([sql]) => /UPDATE communication_campaigns/.test(sql)).length;

  test('a replay of the same status counts nothing', async () => {
    wire('delivered');
    expect(await campaignService.handleDeliveryCallback('m1', 'delivered')).toEqual({ updated: false });
    expect(counted()).toBe(0);
  });

  test('a late delivered after opened is ignored', async () => {
    wire('opened');
    expect((await campaignService.handleDeliveryCallback('m1', 'delivered')).updated).toBe(false);
    expect(counted()).toBe(0);
  });

  test('a forward step updates conditionally and counts once', async () => {
    wire('sent');
    expect((await campaignService.handleDeliveryCallback('m1', 'delivered')).updated).toBe(true);
    const [sql, params] = db.query.mock.calls.find(([q]) => /UPDATE campaign_messages/.test(q));
    expect(sql).toMatch(/WHERE id = \? AND status = \?/);
    expect(params).toEqual(['delivered', 4, 'sent']);
    expect(counted()).toBe(1);
  });

  test('a concurrent callback that lost the race counts nothing', async () => {
    wire('sent', 0);
    expect((await campaignService.handleDeliveryCallback('m1', 'delivered')).updated).toBe(false);
    expect(counted()).toBe(0);
  });
});
