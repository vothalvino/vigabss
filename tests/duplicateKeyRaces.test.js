'use strict';

// =============================================================================
// OPS-20 — the loser of a duplicate-key race is answered, not failed
// =============================================================================
// Two deliveries of one webhook event, or two billing runs for one contract,
// can both read "nothing there yet" and both INSERT. The unique key refuses
// the second, and that ER_DUP_ENTRY used to escape: the webhook answered 500
// (so the provider retried and the event counted as failed) and the billing
// run failed for that contract. tests/integration/db/moneyConcurrency.test.js
// races the real thing against MySQL; this pins the handling offline.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), execute: jest.fn(), getConnection: jest.fn() }));

const db = require('../src/config/database');
const paymentGatewayService = require('../src/services/paymentGatewayService');
const billingService = require('../src/services/billingService');

const dupKey = () => Object.assign(new Error("Duplicate entry for key 'uq'"), { code: 'ER_DUP_ENTRY', errno: 1062 });

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
});

test('a webhook delivery that loses the insert race is a duplicate', async () => {
  let selects = 0;
  db.query.mockImplementation(async (sql) => {
    if (/^SELECT id, status FROM webhook_events/.test(sql)) return [[]];
    if (/^\s*INSERT INTO webhook_events/.test(sql)) throw dupKey();
    if (/^SELECT id FROM webhook_events/.test(sql)) { selects++; return [[{ id: 77 }]]; }
    return [[]];
  });
  const result = await paymentGatewayService.handleWebhookEvent({
    provider: 'stripe', providerEventId: 'evt_1', eventType: 'customer.created', payload: {}, organizationId: 4,
  });
  expect(result).toEqual({ status: 'duplicate', webhookEventId: 77 });
  expect(selects).toBe(1);
  expect(db.query.mock.calls.some(([sql]) => /^UPDATE webhook_events/.test(sql))).toBe(false);
});

test('any other insert error still fails the webhook', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/^SELECT id, status FROM webhook_events/.test(sql)) return [[]];
    if (/^\s*INSERT INTO webhook_events/.test(sql)) throw Object.assign(new Error('gone'), { code: 'PROTOCOL_CONNECTION_LOST' });
    return [[]];
  });
  await expect(paymentGatewayService.handleWebhookEvent({
    provider: 'stripe', providerEventId: 'evt_2', eventType: 'customer.created', payload: {}, organizationId: 4,
  })).rejects.toMatchObject({ code: 'PROTOCOL_CONNECTION_LOST' });
});

test('a billing run that loses the period insert race uses the period the other run created', async () => {
  const raced = { id: 31, contract_id: 9, status: 'pending' };
  db.query.mockImplementation(async (sql) => {
    if (/status = 'pending'/.test(sql) || /status = 'invoiced'/.test(sql)) return [[]];
    if (/^\s*INSERT INTO billing_periods/.test(sql)) throw dupKey();
    if (/WHERE contract_id = \? AND period_start = \?/.test(sql)) return [[raced]];
    return [[]];
  });
  const period = await billingService.generateBillingPeriod({ id: 9, start_date: '2026-01-01', billing_day: 1 });
  expect(period).toBe(raced);
});
