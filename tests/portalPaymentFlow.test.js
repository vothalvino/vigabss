// =============================================================================
// FE-14 — the portal payment flow: one checkout, a way back, honest statuses
// =============================================================================
// Every Pay Now created a new pending transaction and gateway session while an
// earlier one was still open (an unpaid OXXO voucher, a webhook in flight), the
// provider sent cancel and failure to the invoice list, the portal's Overdue
// filter matched the literal status nothing ever writes, and the CFDI button
// downloaded a 404 body as the XML.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/paymentGatewayService', () => ({
  createStripeCheckoutSession: jest.fn().mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }),
  createConektaCheckoutSession: jest.fn(),
}));

const request = require('supertest');
const db = require('../src/config/database');
const config = require('../src/config');
const gateways = require('../src/services/paymentGatewayService');
const checkoutService = require('../src/services/checkoutService');
const { signPortalAccessToken } = require('../src/utils/accessTokens');

const INVOICE = { id: 1, invoice_number: 'F-1', total: '500.00', balance_due: '500.00', currency: 'MXN', status: 'issued', client_id: 10 };
let txRows;
beforeEach(() => {
  jest.clearAllMocks();
  config.appUrl = 'https://isp.example.mx';
  txRows = [];
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM invoices i WHERE i.id = \?/.test(sql)) return [[INVOICE]];
    if (/FROM payment_gateways/.test(sql)) return [[{ id: 5, provider: 'stripe', secret_key_encrypted: 'enc' }]];
    if (/FROM payment_transactions\s+WHERE organization_id = \? AND invoice_id = \?/.test(sql)) return [txRows.slice(-1)];
    if (/INSERT INTO payment_transactions/.test(sql)) {
      txRows.push({ id: 100 + txRows.length, amount: params[5], currency: params[6], raw_response: null });
      return [{ insertId: txRows[txRows.length - 1].id }];
    }
    if (/SET raw_response = \?/.test(sql)) { txRows[txRows.length - 1].raw_response = params[0]; return [{ affectedRows: 1 }]; }
    return [{ affectedRows: 1 }];
  });
});

describe('checkout', () => {
  const start = () => checkoutService.createCheckoutSession({
    organizationId: 1, invoiceId: 1, clientId: 10, returnUrl: 'https://isp.example.mx/portal/invoices/1',
  });

  test('a second Pay Now reopens the open checkout instead of creating another', async () => {
    const first = await start();
    const second = await start();
    expect(second).toMatchObject({ payment_url: first.payment_url, checkout_id: first.checkout_id, reused: true });
    expect(db.query.mock.calls.filter(([sql]) => /INSERT INTO payment_transactions/.test(sql))).toHaveLength(1);
    expect(gateways.createStripeCheckoutSession).toHaveBeenCalledTimes(1);
  });

  test('success and cancel both return to the invoice page', async () => {
    await start();
    const { successUrl, cancelUrl } = gateways.createStripeCheckoutSession.mock.calls[0][1];
    expect(successUrl).toBe('https://isp.example.mx/portal/invoices/1?payment=success');
    expect(cancelUrl).toBe('https://isp.example.mx/portal/invoices/1?payment=cancelled');
  });

  test('an open checkout for a different amount is not reused', async () => {
    await start();
    txRows[0].amount = '250.00';
    await start();
    expect(gateways.createStripeCheckoutSession).toHaveBeenCalledTimes(2);
  });
});

describe('portal invoices', () => {
  const app = require('../src/app');
  const token = signPortalAccessToken({ clientId: 10, organizationId: 1, tokenVersion: 0 }, 900);
  const portalClient = [[{ id: 10, organization_id: 1, name: 'Ana', status: 'active', portal_token_version: 0 }]];

  test('the Overdue filter is derived from the due date', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM clients WHERE id = \?/.test(sql)) return portalClient;
      if (/COUNT\(\*\) AS total FROM invoices/.test(sql)) return [[{ total: 0 }]];
      return [[]];
    });
    await request(app).get('/api/v1/portal/invoices?status=overdue').set('Authorization', `Bearer ${token}`);
    const [sql, params] = db.query.mock.calls.find(([q]) => /FROM invoices i\s+LEFT JOIN/.test(q));
    expect(sql).toMatch(/i\.due_date < CURDATE\(\)/);
    expect(sql).toMatch(/CASE WHEN .* THEN 'overdue' ELSE i\.status END AS status/s);
    expect(params).not.toContain('overdue');
  });

  test('the invoice says what is owed, whether a checkout is open and whether a CFDI exists', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM clients WHERE id = \?/.test(sql)) return portalClient;
      if (/FROM invoices i\s+LEFT JOIN/.test(sql)) {
        return [[{ id: 1, invoice_number: 'F-1', total: '500.00', status: 'overdue', balance_due: '120.50', pending_checkout: 1, has_cfdi: 0, created_at: '2026-10-01' }]];
      }
      return [[]];
    });
    const res = await request(app).get('/api/v1/portal/invoices/1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'overdue', balance_due: 120.5, pending_checkout: true, has_cfdi: false });
  });
});
