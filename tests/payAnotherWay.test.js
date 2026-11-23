'use strict';
// =============================================================================
// "Pay another way": a started checkout can be withdrawn
// =============================================================================
// A subscriber who took an OXXO voucher and then wanted to pay by card was
// sent back to the finished Stripe page for a day, and the voucher stayed
// payable after a new checkout was opened, so an invoice could be paid twice.
// A fresh checkout now voids the voucher at Stripe first, and never withdraws
// a payment that has arrived or is on its way.
// =============================================================================



const mockRequests = [];
let mockReplies = {};
jest.mock('https', () => ({
  request: (options, onResponse) => {
    const { EventEmitter } = require('events');
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      mockRequests.push(`${options.method} ${options.path}`);
      const reply = mockReplies[`${options.method} ${options.path}`] || { status: 404, body: { error: { message: 'not mocked' } } };
      const res = new EventEmitter();
      res.statusCode = reply.status || 200;
      onResponse(res);
      res.emit('data', JSON.stringify(reply.body));
      res.emit('end');
    };
    return req;
  },
}));
jest.mock('../src/config/database', () => ({ query: jest.fn(), execute: jest.fn(), getConnection: jest.fn() }));
jest.mock('../src/utils/encryption', () => ({ decrypt: () => 'sk_test_x', encrypt: (v) => v }));

const db = require('../src/config/database');
const gatewayService = require('../src/services/paymentGatewayService');

const gateway = { id: 5, provider: 'stripe', secret_key_encrypted: 'enc' };

beforeEach(() => { mockRequests.length = 0; mockReplies = {}; db.query.mockReset(); });

describe('withdrawing a Stripe checkout', () => {
  test('a page nobody paid on yet is expired', async () => {
    mockReplies = {
      'GET /v1/checkout/sessions/cs_test_1': { body: { id: 'cs_test_1', status: 'open', payment_status: 'unpaid' } },
      'POST /v1/checkout/sessions/cs_test_1/expire': { body: { id: 'cs_test_1', status: 'expired' } },
    };
    await expect(gatewayService.cancelStripeCheckout(gateway, 'cs_test_1')).resolves.toEqual({ cancelled: true, state: 'expired' });
    expect(mockRequests).toEqual(['GET /v1/checkout/sessions/cs_test_1', 'POST /v1/checkout/sessions/cs_test_1/expire']);
  });

  test('an unpaid OXXO voucher is voided by cancelling its PaymentIntent', async () => {
    mockReplies = {
      'GET /v1/checkout/sessions/cs_test_2': { body: { id: 'cs_test_2', status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_test_2' } },
      'GET /v1/payment_intents/pi_test_2': { body: { id: 'pi_test_2', status: 'requires_action' } },
      'POST /v1/payment_intents/pi_test_2/cancel': { body: { id: 'pi_test_2', status: 'canceled' } },
    };
    await expect(gatewayService.cancelStripeCheckout(gateway, 'cs_test_2')).resolves.toEqual({ cancelled: true, state: 'voided' });
    expect(mockRequests).toContain('POST /v1/payment_intents/pi_test_2/cancel');
  });

  test('a paid checkout is left alone', async () => {
    mockReplies = { 'GET /v1/checkout/sessions/cs_test_3': { body: { id: 'cs_test_3', status: 'complete', payment_status: 'paid', payment_intent: 'pi_test_3' } } };
    await expect(gatewayService.cancelStripeCheckout(gateway, 'cs_test_3')).resolves.toEqual({ cancelled: false, reason: 'paid' });
    expect(mockRequests).toEqual(['GET /v1/checkout/sessions/cs_test_3']);
  });

  test('a payment on its way is left alone, also when it lands between the read and the cancel', async () => {
    mockReplies = {
      'GET /v1/checkout/sessions/cs_test_4': { body: { status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_test_4' } },
      'GET /v1/payment_intents/pi_test_4': { body: { status: 'processing' } },
    };
    await expect(gatewayService.cancelStripeCheckout(gateway, 'cs_test_4')).resolves.toEqual({ cancelled: false, reason: 'processing' });

    mockReplies = {
      'GET /v1/checkout/sessions/cs_test_5': { body: { status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_test_5' } },
      'GET /v1/payment_intents/pi_test_5': { body: { status: 'requires_action' } },
      'POST /v1/payment_intents/pi_test_5/cancel': { status: 400, body: { error: { code: 'payment_intent_unexpected_state', message: 'cannot cancel' } } },
    };
    await expect(gatewayService.cancelStripeCheckout(gateway, 'cs_test_5')).resolves.toEqual({ cancelled: false, reason: 'processing' });
  });

  test('a reference that is not a session id never reaches Stripe', async () => {
    await expect(gatewayService.cancelStripeCheckout(gateway, 'pending_stripe_ab12/../x')).resolves.toMatchObject({ cancelled: true });
    expect(mockRequests).toEqual([]);
  });

  test('a Stripe failure is an error, so the transaction stays open', async () => {
    mockReplies = { 'GET /v1/checkout/sessions/cs_test_6': { status: 500, body: { error: { message: 'boom' } } } };
    await expect(gatewayService.cancelStripeCheckout(gateway, 'cs_test_6')).rejects.toThrow('boom');
  });
});

describe('a fresh checkout for an invoice', () => {
  const checkoutService = require('../src/services/checkoutService');
  const invoice = { id: 1, invoice_number: 'INV-1', total: '500.00', balance_due: '500.00', currency: 'MXN', status: 'issued', client_id: 10 };

  test('voids the voucher at Stripe before closing the transaction, then opens a new page', async () => {
    const order = [];
    jest.spyOn(gatewayService, 'cancelStripeCheckout').mockImplementation(async () => { order.push('stripe-cancel'); return { cancelled: true, state: 'voided' }; });
    jest.spyOn(gatewayService, 'createStripeCheckoutSession').mockResolvedValue({ id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/cs_new' });
    db.query.mockImplementation(async (sql) => {
      if (/FROM invoices/.test(sql)) return [[invoice]];
      if (/FROM payment_gateways/.test(sql)) return [[gateway]];
      if (/SELECT id, gateway_reference_id FROM payment_transactions/.test(sql)) return [[{ id: 77, gateway_reference_id: 'cs_old' }]];
      if (/SET gateway_status = 'cancelled'/.test(sql)) { order.push('tx-cancelled'); return [{ affectedRows: 1 }]; }
      if (/SELECT id, amount, currency, raw_response FROM payment_transactions/.test(sql)) return [[]];
      if (/INSERT INTO payment_transactions/.test(sql)) return [{ insertId: 78 }];
      return [{ affectedRows: 1 }];
    });

    const result = await checkoutService.createCheckoutSession({ organizationId: 1, invoiceId: 1, clientId: 10, fresh: true });
    expect(order).toEqual(['stripe-cancel', 'tx-cancelled']);
    expect(gatewayService.cancelStripeCheckout).toHaveBeenCalledWith(gateway, 'cs_old');
    expect(result).toMatchObject({ checkout_id: 78, payment_url: 'https://checkout.stripe.com/c/pay/cs_new' });
    expect(result.reused).toBeUndefined();
    const cancel = db.query.mock.calls.find(([sql]) => /SET gateway_status = 'cancelled'/.test(sql));
    expect(cancel[0]).toMatch(/WHERE id = \? AND organization_id = \? AND gateway_status = 'pending' AND payment_id IS NULL/);
    expect(cancel[1].slice(1)).toEqual([77, 1]);
  });

  test('a payment already received or on its way is refused with 409 and nothing is closed or opened', async () => {
    jest.spyOn(gatewayService, 'cancelStripeCheckout').mockResolvedValue({ cancelled: false, reason: 'processing' });
    const create = jest.spyOn(gatewayService, 'createStripeCheckoutSession');
    create.mockClear();
    db.query.mockImplementation(async (sql) => {
      if (/FROM invoices/.test(sql)) return [[invoice]];
      if (/FROM payment_gateways/.test(sql)) return [[gateway]];
      if (/SELECT id, gateway_reference_id FROM payment_transactions/.test(sql)) return [[{ id: 77, gateway_reference_id: 'cs_old' }]];
      return [[]];
    });
    await expect(checkoutService.createCheckoutSession({ organizationId: 1, invoiceId: 1, clientId: 10, fresh: true }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(db.query.mock.calls.some(([sql]) => /UPDATE payment_transactions|INSERT INTO payment_transactions/.test(sql))).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  test('without fresh, an open checkout is still reused and nothing is withdrawn', async () => {
    const cancel = jest.spyOn(gatewayService, 'cancelStripeCheckout');
    cancel.mockClear();
    const expires = new Date(Date.now() + 3600e3).toISOString();
    db.query.mockImplementation(async (sql) => {
      if (/FROM invoices/.test(sql)) return [[invoice]];
      if (/FROM payment_gateways/.test(sql)) return [[gateway]];
      if (/SELECT id, amount, currency, raw_response FROM payment_transactions/.test(sql)) {
        return [[{ id: 77, amount: '500.00', currency: 'MXN', raw_response: JSON.stringify({ payment_url: 'https://checkout.stripe.com/c/pay/cs_old', expires_at: expires, provider: 'stripe' }) }]];
      }
      return [[]];
    });
    const result = await checkoutService.createCheckoutSession({ organizationId: 1, invoiceId: 1, clientId: 10 });
    expect(result).toMatchObject({ reused: true, checkout_id: 77 });
    expect(cancel).not.toHaveBeenCalled();
  });
});
