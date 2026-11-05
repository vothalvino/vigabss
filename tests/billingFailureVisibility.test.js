'use strict';
// =============================================================================
// BIL-32 — billing, gateway and PAC failures are counted, not lost
// =============================================================================
// A failed invoice email counted as sent and its error was swallowed; a payment
// webhook that matched no transaction was stored as 'failed' like a processing
// error; reconcile failures, autopay outcomes and PAC errors were only logged,
// so a broken gateway or PAC showed up days later as missing money.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
  withPrimaryContext: fn => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/services/billingService', () => ({
  generateBillingPeriod: jest.fn(),
  generateInvoice: jest.fn(),
}));
jest.mock('../src/services/emailTransport', () => ({ sendEmail: jest.fn(), processQueue: jest.fn(), init: jest.fn() }));

const db = require('../src/config/database');
const billingService = require('../src/services/billingService');
const emailTransport = require('../src/services/emailTransport');
const taskRunner = require('../src/services/taskRunner');
const paymentGatewayService = require('../src/services/paymentGatewayService');
const { registry } = require('../src/utils/metricsRegistry');

const counter = (name, labels) => {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
  const line = registry.render().split('\n').find(l => l.startsWith(`${name}{${want}}`));
  return line ? Number(line.split(' ').pop()) : 0;
};

beforeEach(() => jest.resetAllMocks());

test('an invoice email the transport could not deliver is not counted as sent', async () => {
  const before = counter('billing_emails_total', { kind: 'invoice', result: 'failed' });
  db.query
    .mockResolvedValueOnce([[{ id: 7, client_id: 3, organization_id: 42, plan_name: 'Basic', plan_price: '500.00', plan_currency: 'MXN' }]])
    .mockResolvedValueOnce([[{ name: 'Ana', email: 'ana@example.test', org_name: 'ISP' }]])
    .mockResolvedValueOnce([[{ description: 'Basic', amount: '500.00' }]]);
  billingService.generateBillingPeriod.mockResolvedValueOnce({ id: 100, status: 'pending' });
  billingService.generateInvoice.mockResolvedValueOnce({ id: 9, invoice_number: 'F-9', total: '500.00', currency: 'MXN' });
  emailTransport.sendEmail.mockResolvedValueOnce({ success: false, error: 'SMTP refused' });

  const result = await taskRunner.runAutoInvoice(42);

  expect(result).toMatchObject({ invoices_generated: 1, emails_sent: 0, emails_failed: 1 });
  expect(counter('billing_emails_total', { kind: 'invoice', result: 'failed' })).toBe(before + 1);
});

describe('payment webhooks', () => {
  const event = { provider: 'stripe', providerEventId: 'evt_1', eventType: 'payment_intent.succeeded', organizationId: 42,
    payload: { data: { object: { id: 'pi_unknown' } } } };

  test('an event for an unknown transaction is no_match, not failed, and is counted', async () => {
    const before = counter('payment_webhook_events_total', { provider: 'stripe', status: 'no_match' });
    db.query.mockImplementation(async (sql) => {
      if (/SELECT id, status FROM webhook_events/.test(sql)) return [[]];
      if (/INSERT INTO webhook_events/.test(sql)) return [{ insertId: 55 }];
      if (/FROM payment_transactions/.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    });

    await expect(paymentGatewayService.handleWebhookEvent(event)).resolves.toMatchObject({ status: 'no_match' });

    const update = db.query.mock.calls.find(([sql]) => /UPDATE webhook_events SET status/.test(sql));
    expect(update[0]).toMatch(/status = 'no_match'/);
    expect(counter('payment_webhook_events_total', { provider: 'stripe', status: 'no_match' })).toBe(before + 1);
  });

  test('a redelivered no_match event is processed again', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/SELECT id, status FROM webhook_events/.test(sql)) return [[{ id: 55, status: 'no_match' }]];
      if (/SET status = 'processing'/.test(sql)) return [{ affectedRows: 1 }];
      if (/FROM payment_transactions/.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    });

    await expect(paymentGatewayService.handleWebhookEvent(event)).resolves.toMatchObject({ status: 'no_match' });
    const claim = db.query.mock.calls.find(([sql]) => /SET status = 'processing'/.test(sql));
    expect(claim[0]).toMatch(/status IN \('failed', 'no_match'\)/);
  });
});

test('the migration and schema.sql allow the no_match status', () => {
  const fs = require('fs');
  const path = require('path');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
  expect(schema).toMatch(/status\s+ENUM\('received', 'processing', 'processed', 'failed', 'ignored', 'no_match'\)/);
});

test('billing failure metrics are exported for the alerts', () => {
  require('../src/routes/metrics');
  const names = registry.names();
  for (const name of ['billing_invoices_total', 'billing_emails_total', 'billing_autopay_charges_total',
    'billing_payment_retries_total', 'payment_webhook_events_total', 'payment_reconcile_failures_total',
    'cfdi_pac_errors_total']) {
    expect(names).toContain(name);
  }
});

describe('admin views', () => {
  test('webhook events are the caller organization\'s, without payloads, filterable by status', async () => {
    db.query.mockResolvedValueOnce([[{ id: 3, status: 'no_match' }]]).mockResolvedValueOnce([[{ total: 1 }]]);

    const result = await paymentGatewayService.listWebhookEvents(42, { status: 'no_match', page: '2', limit: '10' });

    expect(result.meta).toEqual({ total: 1, page: 2, limit: 10, totalPages: 1 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE organization_id = \? AND status = \?/);
    expect(sql).not.toMatch(/payload/);
    expect(sql).toMatch(/LIMIT 10 OFFSET 10/);
    expect(params).toEqual([42, 'no_match']);
    await expect(paymentGatewayService.listWebhookEvents(42, { status: 'lost' })).rejects.toMatchObject({ statusCode: 422 });
  });

  test('unsettled transactions are succeeded captures with no payment and no ledger credit', async () => {
    db.query.mockResolvedValueOnce([[{ id: 8 }]]).mockResolvedValueOnce([[{ total: 1 }]]);

    await paymentGatewayService.listUnsettledTransactions(42);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/gateway_status = 'succeeded' AND pt.payment_id IS NULL/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM client_balance_ledger/);
    expect(params).toEqual([42]);
  });

  test('refunded payments a live REP still reports stay listed until the REP is cancelled', async () => {
    db.query.mockResolvedValueOnce([[{ payment_id: 8, rep_id: 31 }]]).mockResolvedValueOnce([[{ total: 1 }]]);

    const result = await paymentGatewayService.listRefundedPaymentsWithLiveRep(42);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE p\.organization_id = \? AND p\.status = 'refunded'/);
    expect(sql).toMatch(/d\.organization_id = p\.organization_id/);
    expect(sql).toMatch(/d\.tipo_comprobante = 'P' AND d\.sat_status IN \('draft', 'vigente', 'cancel_pending'\)/);
    expect(params).toEqual([42]);
    expect(result).toEqual({ data: [{ payment_id: 8, rep_id: 31 }], meta: expect.objectContaining({ total: 1 }) });
  });
});
