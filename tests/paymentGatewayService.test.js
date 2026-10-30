// =============================================================================
// VigaBSS 5.0 — Payment Gateway Service Unit Tests
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
}));

const crypto = require('crypto');
const db = require('../src/config/database');
const paymentGatewayService = require('../src/services/paymentGatewayService');

describe('paymentGatewayService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    paymentGatewayService.paymentCircuitBreaker.reset();
    // Default connection stub so code paths that open a transaction (e.g. the
    // reverseRefund inside refund()) no-op cleanly unless a test overrides it via
    // mockResolvedValueOnce. execute -> [[]] makes "SELECT ... FOR UPDATE" find
    // no row, so reverseRefund returns early.
    db.getConnection.mockResolvedValue({
      beginTransaction: jest.fn(), execute: jest.fn().mockResolvedValue([[]]),
      commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    });
  });

  // =========================================================================
  // getActiveGateway
  // =========================================================================
  describe('getActiveGateway()', () => {
    test('returns active gateway for organization', async () => {
      const gw = { id: 1, provider: 'stripe', status: 'active' };
      db.query.mockResolvedValueOnce([[gw]]);

      const result = await paymentGatewayService.getActiveGateway(42);
      expect(result).toEqual(gw);
    });

    test('returns null when no gateway configured', async () => {
      db.query.mockResolvedValueOnce([[]]);
      const result = await paymentGatewayService.getActiveGateway(42);
      expect(result).toBeNull();
    });

    test('queries with correct organization_id parameter', async () => {
      db.query.mockResolvedValueOnce([[]]);
      await paymentGatewayService.getActiveGateway(99);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('organization_id = ?'),
        [99],
      );
    });
  });

  // =========================================================================
  // Idempotency
  // =========================================================================
  describe('checkIdempotencyKey()', () => {
    test('returns cached response when key exists', async () => {
      const cached = { idempotency_key: 'key-1', status: 'completed', response_body: '{"tx": 1}' };
      db.query.mockResolvedValueOnce([[cached]]);

      const result = await paymentGatewayService.checkIdempotencyKey(42, 'key-1');
      expect(result).toEqual(cached);
    });

    test('returns null when key not found', async () => {
      db.query.mockResolvedValueOnce([[]]);
      const result = await paymentGatewayService.checkIdempotencyKey(42, 'unknown-key');
      expect(result).toBeNull();
    });

    test('queries with correct parameters', async () => {
      db.query.mockResolvedValueOnce([[]]);
      await paymentGatewayService.checkIdempotencyKey(42, 'my-key');
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('idempotency_key = ?'),
        [42, 'my-key'],
      );
    });
  });

  describe('storeIdempotencyKey()', () => {
    test('stores idempotency key with response', async () => {
      db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

      await paymentGatewayService.storeIdempotencyKey(42, 'key-1', 200, { tx: 1 });

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO idempotency_keys'),
        expect.arrayContaining([42, 'key-1', 200]),
      );
    });

    test('uses ON DUPLICATE KEY UPDATE for upsert', async () => {
      db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
      await paymentGatewayService.storeIdempotencyKey(42, 'key-1', 200, {});
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('ON DUPLICATE KEY UPDATE'),
        expect.any(Array),
      );
    });
  });

  // =========================================================================
  // charge
  // =========================================================================
  describe('charge()', () => {
    test('sends customer + off_session to Stripe for a saved-card autopay charge', async () => {
      const https = require('https');
      const EventEmitter = require('events');
      db.query
        .mockResolvedValueOnce([[{ id: 5, provider: 'stripe', status: 'active', secret_key_encrypted: 'enc' }]]) // getActiveGateway
        .mockResolvedValueOnce([{ insertId: 200 }])   // INSERT pending tx
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE tx after charge

      const mockReq = new EventEmitter(); mockReq.write = jest.fn(); mockReq.end = jest.fn(); mockReq.destroy = jest.fn();
      const mockRes = new EventEmitter(); mockRes.statusCode = 200;
      const spy = jest.spyOn(https, 'request').mockImplementation((_opts, cb) => {
        process.nextTick(() => { cb(mockRes); mockRes.emit('data', JSON.stringify({ id: 'pi_1', status: 'succeeded' })); mockRes.emit('end'); });
        return mockReq;
      });

      await paymentGatewayService.charge({
        organizationId: 1, clientId: 7, amount: 100, currency: 'MXN', description: 'x',
        paymentMethodToken: 'pm_1', customer: 'cus_1', offSession: true,
      });

      const body = mockReq.write.mock.calls[0][0];
      expect(body).toMatch(/payment_method=pm_1/);
      expect(body).toMatch(/customer=cus_1/);
      expect(body).toMatch(/off_session=true/);
      spy.mockRestore();
    });

    test('creates transaction and returns success', async () => {
      const gw = { id: 1, provider: 'manual', status: 'active' };
      db.query
        .mockResolvedValueOnce([[gw]])           // getActiveGateway
        .mockResolvedValueOnce([{ insertId: 100 }])  // INSERT transaction
        .mockResolvedValueOnce([{ affectedRows: 1 }]);  // UPDATE succeeded

      const result = await paymentGatewayService.charge({
        organizationId: 42, clientId: 10, amount: 500, currency: 'MXN',
        description: 'Invoice #1', paymentMethodToken: 'tok_123',
      });

      expect(result.status).toBe('succeeded');
      expect(result.transaction_id).toBe(100);
      expect(result.provider).toBe('manual');
    });

    test('throws when no active gateway', async () => {
      db.query.mockResolvedValueOnce([[]]);

      await expect(
        paymentGatewayService.charge({
          organizationId: 99, clientId: 1, amount: 100,
        }),
      ).rejects.toThrow('No active payment gateway configured');
    });

    test('uses MXN as default currency', async () => {
      const gw = { id: 1, provider: 'manual', status: 'active' };
      db.query
        .mockResolvedValueOnce([[gw]])
        .mockResolvedValueOnce([{ insertId: 101 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      await paymentGatewayService.charge({
        organizationId: 42, clientId: 10, amount: 200, description: 'Test',
      });

      const insertCall = db.query.mock.calls[1];
      expect(insertCall[1]).toContain('MXN');
    });

    test('returns idempotent replay when cached response exists', async () => {
      const cached = {
        idempotency_key: 'idem-1',
        status: 'completed',
        response_body: JSON.stringify({ transaction_id: 50, status: 'succeeded' }),
      };
      db.query.mockResolvedValueOnce([[cached]]); // checkIdempotencyKey

      const result = await paymentGatewayService.charge({
        organizationId: 42, clientId: 10, amount: 500,
        idempotencyKey: 'idem-1',
      });

      expect(result.idempotent_replay).toBe(true);
      expect(result.transaction_id).toBe(50);
    });

    test('stores idempotency key on successful charge', async () => {
      const gw = { id: 1, provider: 'manual', status: 'active' };
      db.query
        .mockResolvedValueOnce([[]])              // checkIdempotencyKey — no cache
        .mockResolvedValueOnce([[gw]])            // getActiveGateway
        .mockResolvedValueOnce([{ insertId: 102 }]) // INSERT transaction
        .mockResolvedValueOnce([{ affectedRows: 1 }])  // UPDATE succeeded
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // storeIdempotencyKey

      await paymentGatewayService.charge({
        organizationId: 42, clientId: 10, amount: 300, idempotencyKey: 'idem-2',
      });

      // Last call should be storeIdempotencyKey INSERT
      const lastCall = db.query.mock.calls[db.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain('INSERT INTO idempotency_keys');
    });

    test('records failure in transaction and stores idempotency key on error', async () => {
      const gw = { id: 1, provider: 'stripe', status: 'active', secret_key_encrypted: 'enc' };
      db.query
        .mockResolvedValueOnce([[]])              // checkIdempotencyKey — no cache
        .mockResolvedValueOnce([[gw]])            // getActiveGateway
        .mockResolvedValueOnce([{ insertId: 200 }]) // INSERT transaction
        .mockResolvedValueOnce([{ affectedRows: 1 }])  // UPDATE failed
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // storeIdempotencyKey

      // Mock the circuit breaker to throw (simulating Stripe failure)
      const origCall = paymentGatewayService.paymentCircuitBreaker.call;
      paymentGatewayService.paymentCircuitBreaker.call = jest.fn().mockRejectedValueOnce(new Error('Stripe timeout'));

      const result = await paymentGatewayService.charge({
        organizationId: 42, clientId: 10, amount: 100, idempotencyKey: 'idem-fail',
      });

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Stripe timeout');
      expect(result.transaction_id).toBe(200);

      paymentGatewayService.paymentCircuitBreaker.call = origCall;
    });
  });

  // =========================================================================
  // createConektaCheckoutSession — hosted payment page (order + embedded checkout)
  // =========================================================================
  describe('createConektaCheckoutSession()', () => {
    test('POSTs an order with an embedded HostedPayment checkout and returns the hosted url', async () => {
      const https = require('https');
      const EventEmitter = require('events');
      const encryption = require('../src/utils/encryption');
      const mockDecrypt = jest.spyOn(encryption, 'decrypt').mockReturnValue('key_test');

      const mockReq = new EventEmitter(); mockReq.write = jest.fn(); mockReq.end = jest.fn(); mockReq.destroy = jest.fn();
      const mockRes = new EventEmitter(); mockRes.statusCode = 200;
      let capturedOpts;
      const spy = jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
        capturedOpts = opts;
        process.nextTick(() => {
          cb(mockRes);
          mockRes.emit('data', JSON.stringify({ id: 'ord_1', checkout: { id: 'chk_1', url: 'https://pay.conekta.com/link/ord_1' } }));
          mockRes.emit('end');
        });
        return mockReq;
      });

      const result = await paymentGatewayService.createConektaCheckoutSession(
        { secret_key_encrypted: 'enc' },
        {
          amount: 500, currency: 'MXN', description: 'Invoice INV-1',
          customerName: 'Ada', customerEmail: 'ada@x.com', customerPhone: '+525512345678',
          successUrl: 'https://app/ok', failureUrl: 'https://app/cancel',
          expiresAt: new Date(1893456000000), metadata: { transaction_id: 42 },
        },
      );

      expect(capturedOpts.hostname).toBe('api.conekta.io');
      expect(capturedOpts.path).toBe('/orders');
      const body = JSON.parse(mockReq.write.mock.calls[0][0]);
      expect(body.checkout.type).toBe('HostedPayment');
      expect(body.checkout.success_url).toBe('https://app/ok');
      expect(body.customer_info).toEqual({ name: 'Ada', email: 'ada@x.com', phone: '+525512345678' });
      expect(body.checkout.expires_at).toBe(1893456000); // unix seconds
      expect(body.line_items[0].unit_price).toBe(50000);  // cents
      expect(body.metadata.transaction_id).toBe('42');    // metadata stringified
      expect(result).toEqual({ id: 'ord_1', url: 'https://pay.conekta.com/link/ord_1' });

      spy.mockRestore();
      mockDecrypt.mockRestore();
    });

    test('throws when Conekta returns an error payload', async () => {
      const https = require('https');
      const EventEmitter = require('events');
      const encryption = require('../src/utils/encryption');
      const mockDecrypt = jest.spyOn(encryption, 'decrypt').mockReturnValue('key_test');

      const mockReq = new EventEmitter(); mockReq.write = jest.fn(); mockReq.end = jest.fn(); mockReq.destroy = jest.fn();
      const mockRes = new EventEmitter(); mockRes.statusCode = 422;
      const spy = jest.spyOn(https, 'request').mockImplementation((_opts, cb) => {
        process.nextTick(() => {
          cb(mockRes);
          mockRes.emit('data', JSON.stringify({ type: 'error', details: [{ message: 'invalid currency' }] }));
          mockRes.emit('end');
        });
        return mockReq;
      });

      await expect(paymentGatewayService.createConektaCheckoutSession(
        { secret_key_encrypted: 'enc' },
        { amount: 500, currency: 'MXN', description: 'x', successUrl: 'https://app/ok', expiresAt: new Date(1893456000000) },
      )).rejects.toThrow('invalid currency');

      spy.mockRestore();
      mockDecrypt.mockRestore();
    });
  });

  // =========================================================================
  // refund
  // =========================================================================
  describe('refund()', () => {
    const https = require('https');
    const EventEmitter = require('events');
    const encryption = require('../src/utils/encryption');

    // Stub one processor HTTP exchange; returns the spy and the written bodies.
    function stubProcessor(statusCode, responseBody) {
      const written = [];
      const mockReq = new EventEmitter();
      mockReq.write = jest.fn((chunk) => written.push(String(chunk)));
      mockReq.end = jest.fn();
      mockReq.destroy = jest.fn();
      const mockRes = new EventEmitter();
      mockRes.statusCode = statusCode;
      const spy = jest.spyOn(https, 'request').mockImplementation((_opts, cb) => {
        process.nextTick(() => {
          cb(mockRes);
          mockRes.emit('data', JSON.stringify(responseBody));
          mockRes.emit('end');
        });
        return mockReq;
      });
      const decrypt = jest.spyOn(encryption, 'decrypt').mockReturnValue('sk_test_key');
      return { spy, written, restore: () => { spy.mockRestore(); decrypt.mockRestore(); } };
    }

    const sqlCalls = (re) => db.query.mock.calls.filter((c) => re.test(c[0]));

    // manual provider — DB-only flip, no processor call
    test('refunds a manual (offline) transaction with DB-only flip', async () => {
      const tx = { id: 50, gateway_status: 'succeeded', provider: 'manual', amount: '500.00',
        organization_id: 42, gateway_reference_id: 'manual_ref', secret_key_encrypted: null };
      db.query
        .mockResolvedValueOnce([[tx]])           // JOIN query
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // claim succeeded -> refunded

      const result = await paymentGatewayService.refund(50, { orgId: 42 });
      expect(result.transaction_id).toBe(50);
      expect(result.status).toBe('refunded');
      // No gateway_refund_reference for manual refunds
      expect(result.gateway_refund_reference).toBeUndefined();
    });

    test('binds the organization, client and same-org gateway in the lookup', async () => {
      db.query.mockResolvedValueOnce([[]]);
      await expect(paymentGatewayService.refund(50, { orgId: 42, clientId: 5 }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toMatch(/pt\.organization_id <=> \?/);
      expect(sql).toMatch(/pt\.client_id = \?/);
      expect(sql).toMatch(/pg\.organization_id = pt\.organization_id/);
      expect(params).toEqual([50, 42, 5]);
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('requires the caller organization', async () => {
      await expect(paymentGatewayService.refund(50)).rejects.toThrow(/orgId is required/);
      expect(db.query).not.toHaveBeenCalled();
    });

    test('reverses the settled invoice + writes a ledger debit', async () => {
      const tx = { id: 100, gateway_status: 'succeeded', provider: 'manual', client_id: 5, invoice_id: 50, settled_invoice_id: 50,
        organization_id: 42, amount: '500.00', currency: 'MXN', gateway_reference_id: 'manual_x', secret_key_encrypted: null };
      db.query
        .mockResolvedValueOnce([[tx]])                 // SELECT tx + gateway
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // claim -> refunded
      const conn = {
        beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
        execute: jest.fn()
          .mockResolvedValueOnce([[tx]])          // SELECT tx FOR UPDATE
          .mockResolvedValueOnce([[{ id: 1 }]])   // reconcile CREDIT exists
          .mockResolvedValueOnce([[]])            // no prior reversal DEBIT
          .mockResolvedValueOnce([{ affectedRows: 1 }])  // UPDATE invoices -> issued
          .mockResolvedValueOnce([{ affectedRows: 1 }]), // INSERT ledger debit
      };
      db.getConnection.mockResolvedValue(conn);

      const res = await paymentGatewayService.refund(100, { orgId: 42 });
      expect(res.status).toBe('refunded');
      const revert = conn.execute.mock.calls.find((c) => /UPDATE invoices SET status = 'issued'/.test(c[0]));
      expect(revert).toBeTruthy();
      expect(revert[1]).toEqual([50]); // the linked invoice
      const debit = conn.execute.mock.calls.find((c) => /INSERT INTO client_balance_ledger/.test(c[0]) && /'debit'/.test(c[0]));
      expect(debit).toBeTruthy();
    });

    test('does NOT re-open an invoice this payment did not settle (overpayment) but still offsets the credit', async () => {
      // Overpayment: invoice was already paid by another tx, so reconcile wrote a
      // standing credit but settled_invoice_id is NULL. A refund must not re-open it.
      const tx = { id: 102, gateway_status: 'succeeded', provider: 'manual', client_id: 5, invoice_id: 50, settled_invoice_id: null,
        organization_id: 42, amount: '500.00', currency: 'MXN', gateway_reference_id: 'm', secret_key_encrypted: null };
      db.query.mockResolvedValueOnce([[tx]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
      const conn = {
        beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
        execute: jest.fn()
          .mockResolvedValueOnce([[tx]])          // SELECT tx FOR UPDATE
          .mockResolvedValueOnce([[{ id: 1 }]])   // credit exists
          .mockResolvedValueOnce([[]])            // no debit
          .mockResolvedValueOnce([{ affectedRows: 1 }]), // INSERT ledger debit (no invoice UPDATE)
      };
      db.getConnection.mockResolvedValue(conn);
      await paymentGatewayService.refund(102, { orgId: 42 });
      expect(conn.execute.mock.calls.find((c) => /UPDATE invoices/.test(c[0]))).toBeFalsy();
      expect(conn.execute.mock.calls.find((c) => /INSERT INTO client_balance_ledger/.test(c[0]))).toBeTruthy();
    });

    test('does NOT reverse when the payment was never reconciled (no credit entry)', async () => {
      const tx = { id: 101, gateway_status: 'succeeded', provider: 'manual', client_id: 5, invoice_id: null,
        organization_id: 42, amount: '500.00', currency: 'MXN', gateway_reference_id: 'm', secret_key_encrypted: null };
      db.query.mockResolvedValueOnce([[tx]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
      const conn = {
        beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
        execute: jest.fn().mockResolvedValueOnce([[tx]]).mockResolvedValueOnce([[]]), // tx, then NO credit
      };
      db.getConnection.mockResolvedValue(conn);
      await paymentGatewayService.refund(101, { orgId: 42 });
      const anyInsert = conn.execute.mock.calls.find((c) => /INSERT INTO client_balance_ledger/.test(c[0]));
      expect(anyInsert).toBeFalsy();
    });

    test('throws when transaction not found (including another organization\'s id)', async () => {
      db.query.mockResolvedValueOnce([[]]);
      await expect(paymentGatewayService.refund(999, { orgId: 42 })).rejects.toThrow('Payment transaction not found');
    });

    test('throws when transaction is not succeeded', async () => {
      const tx = { id: 51, gateway_status: 'failed', provider: 'manual', amount: '10.00' };
      db.query.mockResolvedValueOnce([[tx]]);
      await expect(paymentGatewayService.refund(51, { orgId: 42 })).rejects.toThrow('Can only refund succeeded transactions');
    });

    test('throws when transaction is already refunded', async () => {
      const tx = { id: 52, gateway_status: 'refunded', provider: 'manual', amount: '10.00' };
      db.query.mockResolvedValueOnce([[tx]]);
      await expect(paymentGatewayService.refund(52, { orgId: 42 })).rejects.toThrow('Can only refund succeeded transactions');
    });

    test('claims succeeded -> refunded atomically in the caller organization', async () => {
      const tx = { id: 53, gateway_status: 'succeeded', provider: 'manual', amount: '10.00',
        gateway_reference_id: 'manual_ref', secret_key_encrypted: null };
      db.query
        .mockResolvedValueOnce([[tx]])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      await paymentGatewayService.refund(53, { orgId: 42 });

      const [claim] = sqlCalls(/UPDATE payment_transactions SET gateway_status = 'refunded'/);
      expect(claim[0]).toMatch(/gateway_status = 'succeeded'/);
      expect(claim[1]).toEqual([53, 42]);
    });

    test('a concurrent refund that loses the claim never reaches the processor', async () => {
      const tx = { id: 54, gateway_status: 'succeeded', provider: 'stripe', amount: '10.00',
        gateway_reference_id: 'pi_x', secret_key_encrypted: 'enc' };
      db.query
        .mockResolvedValueOnce([[tx]])
        .mockResolvedValueOnce([{ affectedRows: 0 }]); // someone else claimed it
      const proc = stubProcessor(200, { id: 're_x' });
      try {
        await expect(paymentGatewayService.refund(54, { orgId: 42 })).rejects.toThrow(/already being refunded/);
        expect(proc.spy).not.toHaveBeenCalled();
      } finally {
        proc.restore();
      }
    });

    test('refuses a partial gateway refund instead of refunding the full charge', async () => {
      const tx = { id: 55, gateway_status: 'succeeded', provider: 'stripe', amount: '500.00',
        gateway_reference_id: 'pi_y', secret_key_encrypted: 'enc' };
      db.query.mockResolvedValueOnce([[tx]]);
      const proc = stubProcessor(200, { id: 're_y' });
      try {
        await expect(paymentGatewayService.refund(55, { orgId: 42, amount: '100.00' }))
          .rejects.toThrow(/Partial gateway refunds are not supported/);
        expect(proc.spy).not.toHaveBeenCalled();
        expect(db.query).toHaveBeenCalledTimes(1); // no claim
      } finally {
        proc.restore();
      }
    });

    test('refuses an amount above the captured amount', async () => {
      const tx = { id: 56, gateway_status: 'succeeded', provider: 'manual', amount: '500.00' };
      db.query.mockResolvedValueOnce([[tx]]);
      await expect(paymentGatewayService.refund(56, { orgId: 42, amount: 500.01 }))
        .rejects.toThrow(/exceeds the captured/);
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    // stripe provider — must call processor before DB update
    test('calls Stripe refund API with the explicit amount and then updates DB', async () => {
      const tx = {
        id: 60, gateway_status: 'succeeded', provider: 'stripe', amount: '500.00',
        gateway_reference_id: 'pi_test_abc', payment_gateway_id: 1,
        secret_key_encrypted: 'enc_stripe_key',
      };
      db.query
        .mockResolvedValueOnce([[tx]])                 // JOIN query
        .mockResolvedValueOnce([{ affectedRows: 1 }])  // claim
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // store refund reference
      const proc = stubProcessor(200, { id: 're_test_123' });
      try {
        const result = await paymentGatewayService.refund(60, { orgId: 42, amount: '500.00' });

        expect(result.status).toBe('refunded');
        expect(result.gateway_refund_reference).toBe('re_test_123');
        expect(proc.spy).toHaveBeenCalled();
        const form = new URLSearchParams(proc.written.join(''));
        expect(form.get('payment_intent')).toBe('pi_test_abc');
        expect(form.get('amount')).toBe('50000');
        const [refUpdate] = sqlCalls(/SET gateway_reference_id = \?/);
        expect(refUpdate[1]).toEqual(['re_test_123', 60, 42]);
      } finally {
        proc.restore();
      }
    });

    // conekta provider — must call processor before DB update
    test('calls Conekta refund API with the explicit amount and then updates DB', async () => {
      const tx = {
        id: 70, gateway_status: 'succeeded', provider: 'conekta', amount: '116.50',
        gateway_reference_id: 'ord_test_xyz', payment_gateway_id: 2,
        secret_key_encrypted: 'enc_conekta_key',
      };
      db.query
        .mockResolvedValueOnce([[tx]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);
      const proc = stubProcessor(200, { id: 'ref_conekta_456' });
      try {
        const result = await paymentGatewayService.refund(70, { orgId: 42 });

        expect(result.status).toBe('refunded');
        expect(result.gateway_refund_reference).toBe('ref_conekta_456');
        expect(JSON.parse(proc.written.join(''))).toMatchObject({ amount: 11650 });
        const [refUpdate] = sqlCalls(/SET gateway_reference_id = \?/);
        expect(refUpdate[1]).toEqual(['ref_conekta_456', 70, 42]);
      } finally {
        proc.restore();
      }
    });

    // unimplemented provider — must throw, NOT fake success
    test('throws for unimplemented provider (openpay) and releases the claim', async () => {
      const tx = {
        id: 80, gateway_status: 'succeeded', provider: 'openpay', amount: '10.00',
        gateway_reference_id: 'openpay_ref', payment_gateway_id: 3,
      };
      db.query
        .mockResolvedValueOnce([[tx]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])  // claim
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // release

      await expect(paymentGatewayService.refund(80, { orgId: 42 }))
        .rejects.toThrow(/openpay.*not yet supported/i);

      const [release] = sqlCalls(/SET gateway_status = 'succeeded'/);
      expect(release[1]).toEqual([80, 42]);
      expect(db.getConnection).not.toHaveBeenCalled(); // no bookkeeping reversal
    });

    test('restores succeeded and skips bookkeeping when the Stripe refund call fails', async () => {
      const tx = {
        id: 90, gateway_status: 'succeeded', provider: 'stripe', amount: '10.00',
        gateway_reference_id: 'pi_fail', payment_gateway_id: 1,
        secret_key_encrypted: 'enc_key',
      };
      db.query
        .mockResolvedValueOnce([[tx]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])  // claim
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // release
      const proc = stubProcessor(402, { error: { message: 'charge already refunded' } });
      try {
        await expect(paymentGatewayService.refund(90, { orgId: 42 })).rejects.toThrow('charge already refunded');
        expect(sqlCalls(/SET gateway_status = 'succeeded'/)).toHaveLength(1);
        expect(sqlCalls(/SET gateway_reference_id/)).toHaveLength(0);
        expect(db.getConnection).not.toHaveBeenCalled();
      } finally {
        proc.restore();
      }
    });
  });

  // =========================================================================
  // charge — unimplemented provider throws
  // =========================================================================
  describe('charge() — unimplemented provider', () => {
    test('throws for openpay provider instead of faking success', async () => {
      const gw = { id: 5, provider: 'openpay', status: 'active', secret_key_encrypted: 'enc' };
      db.query
        .mockResolvedValueOnce([[gw]])           // getActiveGateway
        .mockResolvedValueOnce([{ insertId: 201 }]) // INSERT transaction
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE failed

      const result = await paymentGatewayService.charge({
        organizationId: 42, clientId: 10, amount: 100, currency: 'MXN',
        description: 'Test',
      });

      // charge() catches the error internally and returns a failed result
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/openpay.*not yet supported/i);
    });

    test('throws for mercadopago provider', async () => {
      const gw = { id: 6, provider: 'mercadopago', status: 'active', secret_key_encrypted: 'enc' };
      db.query
        .mockResolvedValueOnce([[gw]])
        .mockResolvedValueOnce([{ insertId: 202 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      const result = await paymentGatewayService.charge({
        organizationId: 42, clientId: 10, amount: 100, currency: 'MXN',
        description: 'Test',
      });

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/mercadopago.*not yet supported/i);
    });

    test('throws for paypal provider', async () => {
      const gw = { id: 7, provider: 'paypal', status: 'active', secret_key_encrypted: 'enc' };
      db.query
        .mockResolvedValueOnce([[gw]])
        .mockResolvedValueOnce([{ insertId: 203 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      const result = await paymentGatewayService.charge({
        organizationId: 42, clientId: 10, amount: 100, currency: 'MXN',
        description: 'Test',
      });

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/paypal.*not yet supported/i);
    });

    test('manual provider still succeeds without API call', async () => {
      const gw = { id: 8, provider: 'manual', status: 'active' };
      db.query
        .mockResolvedValueOnce([[gw]])
        .mockResolvedValueOnce([{ insertId: 204 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      const result = await paymentGatewayService.charge({
        organizationId: 42, clientId: 10, amount: 100, currency: 'MXN',
        description: 'Cash payment',
      });

      expect(result.status).toBe('succeeded');
      expect(result.provider).toBe('manual');
    });
  });

  // =========================================================================
  // getClientTransactions
  // =========================================================================
  describe('getClientTransactions()', () => {
    test('returns transaction history', async () => {
      const txs = [{ id: 1 }, { id: 2 }];
      db.query.mockResolvedValueOnce([txs]);

      const result = await paymentGatewayService.getClientTransactions(10, 42);
      expect(result).toEqual(txs);
    });

    test('returns empty array when no transactions', async () => {
      db.query.mockResolvedValueOnce([[]]);
      const result = await paymentGatewayService.getClientTransactions(10, 42);
      expect(result).toEqual([]);
    });

    test('queries by client_id and organization_id', async () => {
      db.query.mockResolvedValueOnce([[]]);
      await paymentGatewayService.getClientTransactions(15, 99);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('client_id = ?'),
        [15, 99],
      );
    });
  });

  // =========================================================================
  // Webhook Signature Verification — Stripe
  // =========================================================================
  describe('verifyStripeSignature()', () => {
    const secret = 'whsec_test_secret';

    function makeStripeSignature(payload, timestamp, secret) {
      const signedPayload = `${timestamp}.${payload}`;
      const sig = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
      return `t=${timestamp},v1=${sig}`;
    }

    test('returns true for valid signature', () => {
      const body = '{"id":"evt_1"}';
      const ts = Math.floor(Date.now() / 1000);
      const header = makeStripeSignature(body, ts, secret);
      expect(paymentGatewayService.verifyStripeSignature(body, header, secret)).toBe(true);
    });

    test('returns false for invalid signature', () => {
      const body = '{"id":"evt_1"}';
      const ts = Math.floor(Date.now() / 1000);
      const header = `t=${ts},v1=invalidsignature0000000000000000000000000000000000000000000000000`;
      expect(paymentGatewayService.verifyStripeSignature(body, header, secret)).toBe(false);
    });

    test('returns false for expired timestamp', () => {
      const body = '{"id":"evt_1"}';
      const ts = Math.floor(Date.now() / 1000) - 600; // 10 min old
      const header = makeStripeSignature(body, ts, secret);
      expect(paymentGatewayService.verifyStripeSignature(body, header, secret, 300)).toBe(false);
    });

    test('returns false for missing sigHeader', () => {
      expect(paymentGatewayService.verifyStripeSignature('body', null, secret)).toBe(false);
    });

    test('returns false for missing secret', () => {
      expect(paymentGatewayService.verifyStripeSignature('body', 't=123,v1=abc', null)).toBe(false);
    });

    test('returns false for malformed header', () => {
      expect(paymentGatewayService.verifyStripeSignature('body', 'garbage', secret)).toBe(false);
    });

    test('returns false for tampered body', () => {
      const body = '{"id":"evt_1"}';
      const ts = Math.floor(Date.now() / 1000);
      const header = makeStripeSignature(body, ts, secret);
      expect(paymentGatewayService.verifyStripeSignature('{"id":"evt_2"}', header, secret)).toBe(false);
    });

    test('returns false for future timestamp beyond skew allowance', () => {
      const body = '{"id":"evt_1"}';
      const ts = Math.floor(Date.now() / 1000) + 60; // 60s in future
      const header = makeStripeSignature(body, ts, secret);
      expect(paymentGatewayService.verifyStripeSignature(body, header, secret)).toBe(false);
    });

    test('accepts timestamp slightly in the future (within 5s skew)', () => {
      const body = '{"id":"evt_1"}';
      const ts = Math.floor(Date.now() / 1000) + 3; // 3s in future
      const header = makeStripeSignature(body, ts, secret);
      expect(paymentGatewayService.verifyStripeSignature(body, header, secret)).toBe(true);
    });
  });

  // =========================================================================
  // Webhook Signature Verification — Conekta
  // =========================================================================
  describe('verifyConektaSignature()', () => {
    const secret = 'conekta_webhook_key';

    test('returns true for valid signature', () => {
      const body = '{"id":"ord_1"}';
      const expected = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
      expect(paymentGatewayService.verifyConektaSignature(body, expected, secret)).toBe(true);
    });

    test('returns false for invalid signature', () => {
      const body = '{"id":"ord_1"}';
      const badSig = crypto.createHmac('sha256', 'wrong-key').update(body, 'utf8').digest('hex');
      expect(paymentGatewayService.verifyConektaSignature(body, badSig, secret)).toBe(false);
    });

    test('returns false for missing digest header', () => {
      expect(paymentGatewayService.verifyConektaSignature('body', null, secret)).toBe(false);
    });

    test('returns false for missing secret', () => {
      expect(paymentGatewayService.verifyConektaSignature('body', 'abc', null)).toBe(false);
    });

    test('returns false for non-hex digest', () => {
      // Non-hex strings cause Buffer.from to produce unexpected output
      expect(paymentGatewayService.verifyConektaSignature('body', 'not-hex-at-all!', secret)).toBe(false);
    });
  });

  // =========================================================================
  // handleWebhookEvent
  // =========================================================================
  describe('handleWebhookEvent()', () => {
    test('returns duplicate for already-processed event', async () => {
      db.query.mockResolvedValueOnce([[{ id: 10, status: 'processed' }]]);

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe', providerEventId: 'evt_123',
        eventType: 'payment_intent.succeeded', payload: {},
      });

      expect(result.status).toBe('duplicate');
      expect(result.webhookEventId).toBe(10);
    });

    test('marks unhandled event types as ignored', async () => {
      db.query
        .mockResolvedValueOnce([[]])             // no existing
        .mockResolvedValueOnce([{ insertId: 20 }]) // INSERT webhook_events
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE ignored

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe', providerEventId: 'evt_456',
        eventType: 'customer.created', // not in statusMap
        payload: { data: { object: { id: 'cus_1' } } },
      });

      expect(result.status).toBe('ignored');
    });

    test('returns no_match when transaction not found', async () => {
      db.query
        .mockResolvedValueOnce([[]])             // no existing event
        .mockResolvedValueOnce([{ insertId: 30 }]) // INSERT webhook_events
        .mockResolvedValueOnce([[]])             // no matching transaction
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE failed

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe', providerEventId: 'evt_789',
        eventType: 'payment_intent.succeeded',
        payload: { data: { object: { id: 'pi_missing' } } },
      });

      expect(result.status).toBe('no_match');
    });

    test('processes Stripe payment_intent.succeeded event', async () => {
      const tx = { id: 100, organization_id: 42, client_id: 10, amount: '500.00', currency: 'MXN', gateway_reference_id: 'pi_test' };

      db.query
        .mockResolvedValueOnce([[]])               // no existing event
        .mockResolvedValueOnce([{ insertId: 40 }]) // INSERT webhook_events
        .mockResolvedValueOnce([[tx]])             // find transaction
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE transaction status
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE webhook_events

      // Mock getConnection for reconcilePayment
      const mockConn = {
        beginTransaction: jest.fn(),
        execute: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        release: jest.fn(),
      };
      mockConn.execute
        .mockResolvedValueOnce([[tx]])   // SELECT FOR UPDATE
        .mockResolvedValueOnce([[]]);    // no matching invoices
      db.getConnection.mockResolvedValueOnce(mockConn);

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe', providerEventId: 'evt_success',
        eventType: 'payment_intent.succeeded',
        payload: { data: { object: { id: 'pi_test' } } },
      });

      expect(result.status).toBe('processed');
      expect(result.newStatus).toBe('succeeded');
      expect(result.transactionId).toBe(100);
    });

    test('processes Conekta order.paid event', async () => {
      const tx = { id: 200, organization_id: 42, client_id: 10, amount: '300.00', currency: 'MXN', gateway_reference_id: 'ord_test' };

      db.query
        .mockResolvedValueOnce([[]])               // no existing event
        .mockResolvedValueOnce([{ insertId: 50 }]) // INSERT webhook_events
        .mockResolvedValueOnce([[tx]])             // find transaction
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE transaction status
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE webhook_events

      const mockConn = {
        beginTransaction: jest.fn(),
        execute: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        release: jest.fn(),
      };
      mockConn.execute
        .mockResolvedValueOnce([[tx]])
        .mockResolvedValueOnce([[]]);
      db.getConnection.mockResolvedValueOnce(mockConn);

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'conekta', providerEventId: 'evt_conekta_1',
        eventType: 'order.paid',
        payload: { data: { object: { id: 'ord_test' } } },
      });

      expect(result.status).toBe('processed');
      expect(result.newStatus).toBe('succeeded');
    });

    test('records error and rethrows on processing failure', async () => {
      db.query
        .mockResolvedValueOnce([[]])               // no existing event
        .mockResolvedValueOnce([{ insertId: 60 }]) // INSERT webhook_events
        .mockRejectedValueOnce(new Error('DB error')) // transaction lookup fails
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE error

      await expect(paymentGatewayService.handleWebhookEvent({
        provider: 'stripe', providerEventId: 'evt_err',
        eventType: 'payment_intent.succeeded',
        payload: { data: { object: { id: 'pi_err' } } },
      })).rejects.toThrow('DB error');
    });
  });

  // =========================================================================
  // reconcilePayment
  // =========================================================================
  describe('reconcilePayment()', () => {
    test('reconciles payment with matching invoice', async () => {
      const tx = { id: 1, client_id: 10, organization_id: 42, amount: '500.00', currency: 'MXN', gateway_reference_id: 'pi_1' };
      const invoice = { id: 100, total: '500.00' };

      const mockConn = {
        beginTransaction: jest.fn(),
        execute: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        release: jest.fn(),
      };
      mockConn.execute
        .mockResolvedValueOnce([[tx]])       // SELECT transaction FOR UPDATE
        .mockResolvedValueOnce([[invoice]])   // SELECT invoice FOR UPDATE
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE invoice
        .mockResolvedValueOnce([{ insertId: 1 }]);    // INSERT ledger

      db.getConnection.mockResolvedValueOnce(mockConn);

      await paymentGatewayService.reconcilePayment(1);

      expect(mockConn.commit).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });

    test('rolls back when no matching invoice', async () => {
      const tx = { id: 2, client_id: 10, organization_id: 42, amount: '500.00', currency: 'MXN' };

      const mockConn = {
        beginTransaction: jest.fn(),
        execute: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        release: jest.fn(),
      };
      mockConn.execute
        .mockResolvedValueOnce([[tx]])
        .mockResolvedValueOnce([[]]);  // no invoices

      db.getConnection.mockResolvedValueOnce(mockConn);

      await paymentGatewayService.reconcilePayment(2);

      expect(mockConn.rollback).toHaveBeenCalled();
      expect(mockConn.commit).not.toHaveBeenCalled();
    });

    test('rolls back when amount does not match', async () => {
      const tx = { id: 3, client_id: 10, organization_id: 42, amount: '500.00', currency: 'MXN' };
      const invoice = { id: 101, total: '600.00' }; // different amount

      const mockConn = {
        beginTransaction: jest.fn(),
        execute: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        release: jest.fn(),
      };
      mockConn.execute
        .mockResolvedValueOnce([[tx]])
        .mockResolvedValueOnce([[invoice]]);

      db.getConnection.mockResolvedValueOnce(mockConn);

      await paymentGatewayService.reconcilePayment(3);

      expect(mockConn.rollback).toHaveBeenCalled();
    });

    test('rolls back when transaction not found', async () => {
      const mockConn = {
        beginTransaction: jest.fn(),
        execute: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        release: jest.fn(),
      };
      mockConn.execute.mockResolvedValueOnce([[]]); // no transaction

      db.getConnection.mockResolvedValueOnce(mockConn);

      await paymentGatewayService.reconcilePayment(999);

      expect(mockConn.rollback).toHaveBeenCalled();
    });

    test('handles tolerance for small rounding differences', async () => {
      const tx = { id: 4, client_id: 10, organization_id: 42, amount: '500.005', currency: 'MXN', gateway_reference_id: 'pi_4' };
      const invoice = { id: 102, total: '500.00' };

      const mockConn = {
        beginTransaction: jest.fn(),
        execute: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        release: jest.fn(),
      };
      mockConn.execute
        .mockResolvedValueOnce([[tx]])
        .mockResolvedValueOnce([[invoice]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ insertId: 1 }]);

      db.getConnection.mockResolvedValueOnce(mockConn);

      await paymentGatewayService.reconcilePayment(4);

      expect(mockConn.commit).toHaveBeenCalled();
    });

    test('does not throw on reconciliation error (best-effort)', async () => {
      const mockConn = {
        beginTransaction: jest.fn(),
        execute: jest.fn().mockRejectedValueOnce(new Error('DB failure')),
        commit: jest.fn(),
        rollback: jest.fn(),
        release: jest.fn(),
      };

      db.getConnection.mockResolvedValueOnce(mockConn);

      // Should not throw — reconciliation is best-effort
      await expect(paymentGatewayService.reconcilePayment(5)).resolves.not.toThrow();
      expect(mockConn.rollback).toHaveBeenCalled();
      expect(mockConn.release).toHaveBeenCalled();
    });
  });
});
