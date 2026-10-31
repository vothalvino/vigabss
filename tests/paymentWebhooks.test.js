// =============================================================================
// VigaBSS 5.0 — Payment Webhooks & Idempotency Tests
// =============================================================================

const crypto = require('crypto');

// Mock database module
jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  getConnection: jest.fn(),
  // Webhook processing runs inside the owning organization's database
  // context (WHK-11); here both contexts are the one mocked database.
  withTenantContext: jest.fn((_organizationId, fn) => fn()),
  withPrimaryContext: jest.fn(fn => fn()),
}));

// Mock logger to prevent output noise
jest.mock('../src/utils/logger', () => {
  const mock = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => mock),
  };
  return mock;
});

// Deterministic encryption so the per-gateway webhook secret loader is testable.
// Mirrors the REAL decrypt(): it returns the value UNCHANGED when it cannot
// decrypt (never throws for corrupt ciphertext). With isConfigured()=true, the
// loader detects a ciphertext-shaped value that came back unchanged and treats
// it as unconfigured (503) — a plaintext-shaped secret passes straight through.
jest.mock('../src/utils/encryption', () => ({
  encrypt: (v) => v,
  decrypt: jest.fn((v) => v),
  getKey: () => Buffer.alloc(32),
  isConfigured: () => true,
}));

const db = require('../src/config/database');
const paymentGatewayService = require('../src/services/paymentGatewayService');

// Test stand-in for a Conekta webhook key (POST /webhook_keys): Conekta keeps
// the private half and signs; the receiver is configured with the public PEM.
const CONEKTA_KEYS = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CONEKTA_PUBLIC_PEM = CONEKTA_KEYS.publicKey.export({ type: 'spki', format: 'pem' });
const conektaDigest = (body) => crypto.sign('RSA-SHA256', Buffer.from(body, 'utf8'), CONEKTA_KEYS.privateKey).toString('base64');

describe('Payment Webhooks & Idempotency', () => {
  let mockConnection;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection = {
      beginTransaction: jest.fn(),
      execute: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    db.getConnection.mockResolvedValue(mockConnection);
  });

  // =========================================================================
  // Stripe Signature Verification
  // =========================================================================
  describe('verifyStripeSignature()', () => {
    const secret = 'whsec_test_secret_key';

    function buildSignature(body, secret, timestamp) {
      const ts = timestamp || Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
      return { header: `t=${ts},v1=${sig}`, timestamp: ts };
    }

    test('returns true for valid signature', () => {
      const body = '{"id":"evt_123","type":"payment_intent.succeeded"}';
      const { header } = buildSignature(body, secret);
      expect(paymentGatewayService.verifyStripeSignature(body, header, secret)).toBe(true);
    });

    test('returns false for wrong secret', () => {
      const body = '{"id":"evt_123"}';
      const { header } = buildSignature(body, secret);
      expect(paymentGatewayService.verifyStripeSignature(body, header, 'wrong_secret')).toBe(false);
    });

    test('returns false for tampered body', () => {
      const body = '{"id":"evt_123"}';
      const { header } = buildSignature(body, secret);
      expect(paymentGatewayService.verifyStripeSignature('{"id":"evt_999"}', header, secret)).toBe(false);
    });

    test('returns false when signature header is missing', () => {
      expect(paymentGatewayService.verifyStripeSignature('body', null, secret)).toBe(false);
      expect(paymentGatewayService.verifyStripeSignature('body', '', secret)).toBe(false);
    });

    test('returns false when secret is missing', () => {
      const body = '{"id":"evt_123"}';
      const { header } = buildSignature(body, secret);
      expect(paymentGatewayService.verifyStripeSignature(body, header, null)).toBe(false);
      expect(paymentGatewayService.verifyStripeSignature(body, header, '')).toBe(false);
    });

    test('returns false for expired timestamp (beyond tolerance)', () => {
      const body = '{"id":"evt_123"}';
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const { header } = buildSignature(body, secret, oldTimestamp);
      expect(paymentGatewayService.verifyStripeSignature(body, header, secret, 300)).toBe(false);
    });

    test('returns true for timestamp within tolerance', () => {
      const body = '{"id":"evt_123"}';
      const recentTimestamp = Math.floor(Date.now() / 1000) - 100; // 100 seconds ago
      const { header } = buildSignature(body, secret, recentTimestamp);
      expect(paymentGatewayService.verifyStripeSignature(body, header, secret, 300)).toBe(true);
    });

    test('returns false for malformed header', () => {
      expect(paymentGatewayService.verifyStripeSignature('body', 'garbage', secret)).toBe(false);
      expect(paymentGatewayService.verifyStripeSignature('body', 'v1=abc', secret)).toBe(false);
      expect(paymentGatewayService.verifyStripeSignature('body', 't=123', secret)).toBe(false);
    });

    test('returns false for future timestamp (beyond clock-skew allowance)', () => {
      const body = '{"id":"evt_future"}';
      const futureTimestamp = Math.floor(Date.now() / 1000) + 60; // 60 seconds in the future
      const { header } = buildSignature(body, secret, futureTimestamp);
      expect(paymentGatewayService.verifyStripeSignature(body, header, secret)).toBe(false);
    });

    test('returns false for signature with mismatched hex length', () => {
      const body = '{"id":"evt_123"}';
      const ts = Math.floor(Date.now() / 1000);
      const header = `t=${ts},v1=short`;
      expect(paymentGatewayService.verifyStripeSignature(body, header, secret)).toBe(false);
    });
  });

  // =========================================================================
  // Conekta Signature Verification
  // =========================================================================
  // Conekta signs SHA-256 of the raw body with the webhook key's RSA private
  // key and sends it base64 in DIGEST; only the public key verifies it (BIL-25).
  // These tests previously built an HMAC-hex digest with the same (wrong)
  // scheme the receiver used, so they could never detect it. They now sign
  // with a generated RSA key pair, plus the vendor's own published sample.
  describe('verifyConektaSignature()', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' });

    function buildDigest(body, key = privateKey) {
      return crypto.sign('RSA-SHA256', Buffer.from(body, 'utf8'), key).toString('base64');
    }

    test('verifies Conekta\'s own published sample (docs "Verificar firmas")', () => {
      const vendor = require('./fixtures/conektaWebhookSignature.json');
      expect(paymentGatewayService.verifyConektaSignature(vendor.payload, vendor.digest, vendor.public_key)).toBe(true);
      expect(paymentGatewayService.verifyConektaSignature(`${vendor.payload} `, vendor.digest, vendor.public_key)).toBe(false);
    });

    test('returns true for a valid RSA-SHA256 base64 digest', () => {
      const body = '{"id":"evt_conekta_1","type":"order.paid"}';
      expect(paymentGatewayService.verifyConektaSignature(body, buildDigest(body), publicPem)).toBe(true);
    });

    test('accepts the JSON-escaped PEM copied from the /webhook_keys response', () => {
      const body = '{"id":"evt_conekta_1"}';
      const escaped = publicPem.replace(/\n/g, '\\n');
      expect(paymentGatewayService.verifyConektaSignature(body, buildDigest(body), escaped)).toBe(true);
    });

    test('returns false for a different key pair', () => {
      const body = '{"id":"evt_conekta_1"}';
      expect(paymentGatewayService.verifyConektaSignature(body, buildDigest(body), otherPem)).toBe(false);
    });

    test('returns false for tampered body', () => {
      const body = '{"id":"evt_conekta_1"}';
      expect(paymentGatewayService.verifyConektaSignature('{"id":"tampered"}', buildDigest(body), publicPem)).toBe(false);
    });

    test('returns false when digest header is missing', () => {
      expect(paymentGatewayService.verifyConektaSignature('body', null, publicPem)).toBe(false);
      expect(paymentGatewayService.verifyConektaSignature('body', '', publicPem)).toBe(false);
    });

    test('returns false when the key is missing', () => {
      const body = '{"id":"evt_conekta_1"}';
      expect(paymentGatewayService.verifyConektaSignature(body, buildDigest(body), null)).toBe(false);
    });

    test('an HMAC "secret" is not a key: the old hex HMAC digest never verifies', () => {
      const body = '{"id":"evt_conekta_1"}';
      const hmac = crypto.createHmac('sha256', 'conekta_webhook_key_123').update(body, 'utf8').digest('hex');
      expect(paymentGatewayService.parseConektaPublicKey('conekta_webhook_key_123')).toBeNull();
      expect(paymentGatewayService.verifyConektaSignature(body, hmac, 'conekta_webhook_key_123')).toBe(false);
      expect(paymentGatewayService.verifyConektaSignature(body, hmac, publicPem)).toBe(false);
    });

    test('returns false for a non-base64 digest', () => {
      expect(paymentGatewayService.verifyConektaSignature('body', 'not-base64!@#', publicPem)).toBe(false);
    });
  });

  // =========================================================================
  // Idempotency
  // =========================================================================
  describe('Idempotency', () => {
    describe('checkIdempotencyKey()', () => {
      test('returns cached entry when key exists and is not expired', async () => {
        const cached = {
          id: 1,
          idempotency_key: 'key-123',
          status: 'completed',
          response_body: '{"transaction_id":100,"status":"succeeded"}',
        };
        db.query.mockResolvedValueOnce([[cached]]);

        const result = await paymentGatewayService.checkIdempotencyKey(42, 'key-123');
        expect(result).toEqual(cached);
        expect(db.query).toHaveBeenCalledWith(
          expect.stringContaining('idempotency_keys'),
          [42, 'key-123'],
        );
      });

      test('returns null when key does not exist', async () => {
        db.query.mockResolvedValueOnce([[]]);
        const result = await paymentGatewayService.checkIdempotencyKey(42, 'nonexistent');
        expect(result).toBeNull();
      });
    });

    describe('storeIdempotencyKey()', () => {
      test('stores key with response', async () => {
        db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

        await paymentGatewayService.storeIdempotencyKey(42, 'key-456', 200, { status: 'succeeded' });
        expect(db.query).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO idempotency_keys'),
          expect.arrayContaining([42, 'key-456', 200]),
        );
      });
    });

    describe('charge() with idempotencyKey', () => {
      test('returns cached result on duplicate key', async () => {
        const cachedResponse = { transaction_id: 100, status: 'succeeded' };
        const cached = {
          id: 1,
          status: 'completed',
          response_body: JSON.stringify(cachedResponse),
        };
        db.query.mockResolvedValueOnce([[cached]]); // checkIdempotencyKey

        const result = await paymentGatewayService.charge({
          organizationId: 42, clientId: 10, amount: 500,
          idempotencyKey: 'key-123',
        });

        expect(result.idempotent_replay).toBe(true);
        expect(result.transaction_id).toBe(100);
        // Should not create a new transaction
        expect(db.query).toHaveBeenCalledTimes(1);
      });

      // A 'manual' gateway no longer records a "charge" as succeeded (WHK-01),
      // so these idempotency checks run against a stubbed Stripe call.
      function stubStripeSucceeded() {
        const https = require('https');
        const EventEmitter = require('events');
        const mockReq = new EventEmitter(); mockReq.write = jest.fn(); mockReq.end = jest.fn(); mockReq.destroy = jest.fn();
        const mockRes = new EventEmitter(); mockRes.statusCode = 200;
        return jest.spyOn(https, 'request').mockImplementation((_opts, cb) => {
          process.nextTick(() => { cb(mockRes); mockRes.emit('data', JSON.stringify({ id: 'pi_1', status: 'succeeded' })); mockRes.emit('end'); });
          return mockReq;
        });
      }

      test('processes normally when key is new', async () => {
        const spy = stubStripeSucceeded();
        db.query
          .mockResolvedValueOnce([[]])                  // checkIdempotencyKey — not found
          .mockResolvedValueOnce([[ { id: 1, provider: 'stripe', status: 'active', secret_key_encrypted: 'sk' }]])  // getActiveGateway
          .mockResolvedValueOnce([{ insertId: 200 }])   // INSERT transaction
          .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE succeeded
          .mockResolvedValueOnce([{ affectedRows: 1 }]); // storeIdempotencyKey

        const result = await paymentGatewayService.charge({
          organizationId: 42, clientId: 10, amount: 500,
          idempotencyKey: 'new-key-789',
        });

        expect(result.status).toBe('succeeded');
        expect(result.transaction_id).toBe(200);
        expect(result.idempotent_replay).toBeUndefined();
        spy.mockRestore();
      });

      test('charge without idempotency key works normally', async () => {
        const spy = stubStripeSucceeded();
        const gw = { id: 1, provider: 'stripe', status: 'active', secret_key_encrypted: 'sk' };
        db.query
          .mockResolvedValueOnce([[gw]])           // getActiveGateway
          .mockResolvedValueOnce([{ insertId: 300 }])  // INSERT transaction
          .mockResolvedValueOnce([{ affectedRows: 1 }]);  // UPDATE succeeded

        const result = await paymentGatewayService.charge({
          organizationId: 42, clientId: 10, amount: 500,
        });

        expect(result.status).toBe('succeeded');
        expect(result.transaction_id).toBe(300);
        spy.mockRestore();
      });

      test('handles cached response_body as parsed object', async () => {
        const cachedResponse = { transaction_id: 100, status: 'succeeded' };
        const cached = {
          id: 1,
          status: 'completed',
          response_body: cachedResponse, // Already parsed (e.g. by MySQL JSON column)
        };
        db.query.mockResolvedValueOnce([[cached]]);

        const result = await paymentGatewayService.charge({
          organizationId: 42, clientId: 10, amount: 500,
          idempotencyKey: 'key-obj',
        });

        expect(result.idempotent_replay).toBe(true);
        expect(result.transaction_id).toBe(100);
      });
    });
  });

  // =========================================================================
  // Webhook Event Handling
  // =========================================================================
  describe('handleWebhookEvent()', () => {
    test('processes Stripe payment_intent.succeeded event', async () => {
      const payload = {
        id: 'evt_stripe_1',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_abc123', amount: 50000 } },
      };

      db.query
        .mockResolvedValueOnce([[]])                 // No duplicate event
        .mockResolvedValueOnce([{ insertId: 10 }])   // INSERT webhook_events
        .mockResolvedValueOnce([[{                    // Find transaction
          id: 100, client_id: 5, organization_id: 42,
          amount: '500.00', currency: 'MXN',
          gateway_reference_id: 'pi_abc123',
        }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE payment_transactions
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE webhook_events processed

      // reconcilePayment uses mockConnection.execute (via getConnection)
      mockConnection.execute
        .mockResolvedValueOnce([[{                    // SELECT payment_transaction FOR UPDATE
          id: 100, client_id: 5, organization_id: 42,
          amount: '500.00', currency: 'MXN',
          gateway_reference_id: 'pi_abc123',
        }]])
        .mockResolvedValueOnce([[{                    // SELECT oldest unpaid invoice FOR UPDATE
          id: 50, total: '500.00',
        }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE invoices SET status=paid
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // INSERT client_balance_ledger credit

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe',
        providerEventId: 'evt_stripe_1',
        eventType: 'payment_intent.succeeded',
        payload,
      });

      expect(result.status).toBe('processed');
      expect(result.newStatus).toBe('succeeded');
      expect(result.transactionId).toBe(100);
      // The post-match UPDATE must NOT re-home organization_id — that would move a
      // global-route row out of its dedup partition and let redeliveries reprocess.
      const upd = db.query.mock.calls.find(c => /UPDATE webhook_events SET transaction_id/.test(c[0]));
      expect(upd[0]).not.toMatch(/organization_id/);
    });

    test('processes checkout.session.completed (paid) — settles the LINKED invoice, not the oldest', async () => {
      const payload = {
        id: 'evt_cs_1',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_test_123', payment_status: 'paid', amount_total: 50000 } },
      };
      // The transaction is linked (invoice_id=77) to the invoice the customer chose.
      const linkedTx = { id: 200, client_id: 5, invoice_id: 77, organization_id: 42, payment_gateway_id: 7, amount: '500.00', currency: 'MXN', gateway_reference_id: 'cs_test_123', gateway_status: 'succeeded', payment_id: null };

      db.query
        .mockResolvedValueOnce([[]])                  // No duplicate
        .mockResolvedValueOnce([{ insertId: 12 }])    // INSERT webhook_events
        .mockResolvedValueOnce([[linkedTx]])          // Find transaction by cs_ session id
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE payment_transactions
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE webhook_events processed
        .mockResolvedValue([{ affectedRows: 0 }]);    // post-commit side effects

      mockConnection.execute.mockImplementation(async (sql) => {
        if (/FROM payment_transactions WHERE id = \? FOR UPDATE/.test(sql)) return [[linkedTx]];
        if (/FROM client_balance_ledger/.test(sql)) return [[]];
        if (/FROM payment_gateways/.test(sql)) return [[{ provider: 'stripe' }]];
        if (/FROM invoices i/.test(sql)) return [[{ id: 77, status: 'issued', total: '500.00', balance_due: '500.00' }]];
        if (/SUM\(amount\) AS total_allocated/.test(sql)) return [[{ total_allocated: '500.00' }]];
        if (/^\s*INSERT/.test(sql)) return [{ insertId: 901 }];
        return [{ affectedRows: 1 }];
      });

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe', providerEventId: 'evt_cs_1', eventType: 'checkout.session.completed', payload,
      });

      expect(result.status).toBe('processed');
      expect(result.newStatus).toBe('succeeded');
      expect(result.reconciliation).toBe('reconciled');
      // Only the LINKED invoice (77) is a target — NOT a FIFO/oldest heuristic —
      // and it is paid through a payment allocation.
      const target = mockConnection.execute.mock.calls.find((c) => /FROM invoices i/.test(c[0]));
      expect(target[0]).toMatch(/AND i\.id IN \(\?\)/);
      expect(target[1]).toEqual([5, 42, 'issued', 'sent', 'overdue', 77]);
      const alloc = mockConnection.execute.mock.calls.find((c) => /INSERT INTO payment_allocations/.test(c[0]));
      expect(alloc[1]).toEqual([901, 77, 500]);
      const paid = mockConnection.execute.mock.calls.find((c) => /UPDATE invoices SET status = \?, paid_at/.test(c[0]));
      expect(paid[1]).toEqual(['paid', 77]);
    });

    test('checkout.session.completed recovers a tx via metadata.transaction_id when the reference lookup misses', async () => {
      // Within the organization the event belongs to (gateway route, or the
      // env route reading metadata.organization_id) — WHK-11.
      const payload = {
        id: 'evt_cs_orphan',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_orphan', payment_status: 'paid', metadata: { transaction_id: '201', organization_id: '42' } } },
      };
      const tx = { id: 201, client_id: 5, invoice_id: 78, organization_id: 42, amount: '100.00', currency: 'MXN', gateway_reference_id: 'pending_stripe_x' };

      db.query
        .mockResolvedValueOnce([[]])                  // No duplicate
        .mockResolvedValueOnce([{ insertId: 14 }])    // INSERT webhook_events
        .mockResolvedValueOnce([[]])                  // find by gateway_reference_id -> MISS
        .mockResolvedValueOnce([[tx]])                // fallback: find by metadata.transaction_id
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE payment_transactions
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE webhook_events processed

      mockConnection.execute
        .mockResolvedValueOnce([[tx]])
        .mockResolvedValueOnce([[{ id: 78, status: 'issued', total: '100.00' }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe', providerEventId: 'evt_cs_orphan', eventType: 'checkout.session.completed', payload, organizationId: 42,
      });
      expect(result.status).toBe('processed');
      expect(result.transactionId).toBe(201);
      const fallback = db.query.mock.calls.find(([sql]) => /FROM payment_transactions WHERE id = \?/.test(sql));
      expect(fallback[0]).toMatch(/AND organization_id = \?/);
      expect(fallback[1]).toEqual(['201', 42]);
    });

    test('without a known organization, metadata.transaction_id is never looked up by id alone', async () => {
      const payload = {
        id: 'evt_cs_foreign',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_foreign', payment_status: 'paid', metadata: { transaction_id: '201' } } },
      };
      db.query
        .mockResolvedValueOnce([[]])                  // No duplicate
        .mockResolvedValueOnce([{ insertId: 15 }])    // INSERT webhook_events
        .mockResolvedValueOnce([[]])                  // find by gateway_reference_id -> MISS
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE webhook_events no match

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe', providerEventId: 'evt_cs_foreign', eventType: 'checkout.session.completed', payload,
      });
      expect(result.status).toBe('no_match');
      expect(db.query.mock.calls.some(([sql]) => /FROM payment_transactions WHERE id = \?/.test(sql))).toBe(false);
    });

    test('checkout.session.completed in SETUP mode enrolls autopay (no payment reconcile)', async () => {
      const payload = {
        id: 'evt_setup',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_setup', mode: 'setup', metadata: { client_id: '7', gateway_id: '5', organization_id: '42' } } },
      };
      const spy = jest.spyOn(paymentGatewayService, 'retrieveStripeCheckoutSession')
        .mockResolvedValue({ mode: 'setup', customer: 'cus_1', paymentMethod: 'pm_1', card: null, metadata: { client_id: 7 } });

      db.query
        .mockResolvedValueOnce([[]])                                                   // dup
        .mockResolvedValueOnce([{ insertId: 40 }])                                     // INSERT webhook_events
        .mockResolvedValueOnce([[{ id: 5, provider: 'stripe', organization_id: 42, secret_key_encrypted: 'e' }]]) // gateway (loadStripeGatewayById)
        .mockResolvedValueOnce([[{ id: 7 }]])                                          // client belongs to gateway org
        .mockResolvedValueOnce([{ affectedRows: 1 }])                                  // clear other defaults
        .mockResolvedValueOnce([{ insertId: 30 }])                                     // INSERT profile
        .mockResolvedValueOnce([{ affectedRows: 1 }]);                                 // UPDATE webhook_events processed

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe', providerEventId: 'evt_setup', eventType: 'checkout.session.completed', payload, organizationId: 42,
      });

      expect(result.status).toBe('processed');
      expect(result.autopay).toBe(true);
      expect(db.query.mock.calls.find((c) => /INSERT INTO recurring_payment_profiles/.test(c[0]))).toBeTruthy();
      spy.mockRestore();
    });

    test('ignores checkout.session.completed that is not yet paid (async method)', async () => {
      const payload = {
        id: 'evt_cs_2',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_test_async', payment_status: 'unpaid' } },
      };

      db.query
        .mockResolvedValueOnce([[]])                  // No duplicate
        .mockResolvedValueOnce([{ insertId: 13 }])    // INSERT webhook_events
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE webhook_events -> ignored

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe',
        providerEventId: 'evt_cs_2',
        eventType: 'checkout.session.completed',
        payload,
      });

      expect(result.status).toBe('ignored');
    });

    test('processes Stripe payment_intent.payment_failed event', async () => {
      const payload = {
        id: 'evt_stripe_2',
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_failed123' } },
      };

      db.query
        .mockResolvedValueOnce([[]])                 // No duplicate
        .mockResolvedValueOnce([{ insertId: 11 }])   // INSERT webhook_events
        .mockResolvedValueOnce([[{                    // Find transaction
          id: 101, client_id: 5, organization_id: 42,
          gateway_reference_id: 'pi_failed123',
        }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE payment_transactions
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE webhook_events

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe',
        providerEventId: 'evt_stripe_2',
        eventType: 'payment_intent.payment_failed',
        payload,
      });

      expect(result.status).toBe('processed');
      expect(result.newStatus).toBe('failed');
    });

    test('a FULL Stripe charge.refunded reverses the settled invoice', async () => {
      const payload = {
        id: 'evt_stripe_3',
        type: 'charge.refunded',
        data: { object: { id: 'ch_refund123', payment_intent: 'pi_original', refunded: true, amount: 50000, amount_refunded: 50000 } },
      };
      const tx = { id: 102, client_id: 5, organization_id: 42, settled_invoice_id: 60, amount: '500.00', currency: 'MXN', gateway_reference_id: 'pi_original' };

      db.query
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ insertId: 12 }])
        .mockResolvedValueOnce([[tx]])                 // find tx by pi_original
        .mockResolvedValueOnce([{ affectedRows: 1 }])  // UPDATE tx -> refunded
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE webhook_events processed

      mockConnection.execute
        .mockResolvedValueOnce([[tx]])                 // reverseRefund: SELECT tx FOR UPDATE
        .mockResolvedValueOnce([[{ id: 1 }]])          // credit exists
        .mockResolvedValueOnce([[]])                   // no prior debit
        .mockResolvedValueOnce([{ affectedRows: 1 }])  // UPDATE invoices -> issued
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // INSERT ledger debit

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe', providerEventId: 'evt_stripe_3', eventType: 'charge.refunded', payload,
      });

      expect(result.status).toBe('processed');
      expect(result.newStatus).toBe('refunded');
      const revert = mockConnection.execute.mock.calls.find((c) => /UPDATE invoices SET status = 'issued'/.test(c[0]));
      expect(revert).toBeTruthy();
      expect(revert[1]).toEqual([60]); // the invoice this tx settled
    });

    test('a PARTIAL Stripe charge.refunded is ignored (no full-invoice reversal)', async () => {
      const payload = {
        id: 'evt_partial',
        type: 'charge.refunded',
        data: { object: { id: 'ch_p', payment_intent: 'pi_p', refunded: false, amount: 50000, amount_refunded: 1000 } },
      };
      db.query
        .mockResolvedValueOnce([[]])                  // dup
        .mockResolvedValueOnce([{ insertId: 13 }])    // INSERT webhook_events
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE webhook_events -> ignored

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe', providerEventId: 'evt_partial', eventType: 'charge.refunded', payload,
      });
      expect(result.status).toBe('ignored');
    });

    test('processes Stripe charge.dispute.created event', async () => {
      const payload = {
        id: 'evt_stripe_4',
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_dispute1', payment_intent: 'pi_disputed' } },
      };

      db.query
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ insertId: 13 }])
        .mockResolvedValueOnce([[{
          id: 103, client_id: 5, organization_id: 42,
          gateway_reference_id: 'pi_disputed',
        }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe',
        providerEventId: 'evt_stripe_4',
        eventType: 'charge.dispute.created',
        payload,
      });

      expect(result.status).toBe('processed');
      expect(result.newStatus).toBe('disputed');
    });

    test('returns duplicate for already-processed events', async () => {
      db.query.mockResolvedValueOnce([[{ id: 10, status: 'processed' }]]);

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe',
        providerEventId: 'evt_dup_1',
        eventType: 'payment_intent.succeeded',
        payload: { id: 'evt_dup_1', type: 'payment_intent.succeeded' },
      });

      expect(result.status).toBe('duplicate');
      expect(result.webhookEventId).toBe(10);
    });

    test('dedup is PER-ORG: the same provider_event_id under a different org is NOT a duplicate (migration 417)', async () => {
      db.query
        .mockResolvedValueOnce([[]])                 // dedup scoped to org 6 → none
        .mockResolvedValueOnce([{ insertId: 77 }])   // INSERT webhook_events
        .mockResolvedValueOnce([[]])                 // org-scoped tx lookup → no match (fine)
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE webhook_events → no_match

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe',
        providerEventId: 'evt_shared_acct',
        eventType: 'payment_intent.succeeded',
        payload: { id: 'evt_shared_acct', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } },
        organizationId: 6,
      });

      expect(result.status).not.toBe('duplicate'); // org 5 owning the same id would not block org 6
      // the dedup SELECT is scoped to the org_dedup partition and the INSERT sets org
      const dedup = db.query.mock.calls.find(c => /SELECT id, status FROM webhook_events/.test(c[0]));
      expect(dedup[0]).toMatch(/org_dedup = \?/);
      expect(dedup[1]).toEqual(['stripe', 'evt_shared_acct', 6]);
      const ins = db.query.mock.calls.find(c => /INSERT INTO webhook_events/.test(c[0]));
      expect(ins[1][0]).toBe(6); // organization_id set at insert
    });

    test('marks unhandled event types as ignored', async () => {
      db.query
        .mockResolvedValueOnce([[]])                 // No duplicate
        .mockResolvedValueOnce([{ insertId: 14 }])   // INSERT webhook_events
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE to ignored

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe',
        providerEventId: 'evt_unknown_type',
        eventType: 'customer.subscription.created',
        payload: { id: 'evt_unknown_type', type: 'customer.subscription.created', data: { object: {} } },
      });

      expect(result.status).toBe('ignored');
    });

    test('marks event as no_match when transaction not found', async () => {
      const payload = {
        id: 'evt_no_match',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_nonexistent' } },
      };

      db.query
        .mockResolvedValueOnce([[]])                 // No duplicate
        .mockResolvedValueOnce([{ insertId: 15 }])   // INSERT webhook_events
        .mockResolvedValueOnce([[]])                  // No matching transaction
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE event to failed

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'stripe',
        providerEventId: 'evt_no_match',
        eventType: 'payment_intent.succeeded',
        payload,
      });

      expect(result.status).toBe('no_match');
    });

    test('processes Conekta order.paid event', async () => {
      const payload = {
        id: 'evt_conekta_1',
        type: 'order.paid',
        data: { object: { id: 'ord_conekta_123', payment_status: 'paid' } },
      };

      db.query
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ insertId: 20 }])
        .mockResolvedValueOnce([[{
          id: 200, client_id: 10, organization_id: 50,
          amount: '1000.00', currency: 'MXN',
          gateway_reference_id: 'ord_conekta_123',
        }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      // reconcilePayment uses mockConnection.execute
      mockConnection.execute
        .mockResolvedValueOnce([[{
          id: 200, client_id: 10, organization_id: 50,
          amount: '1000.00', currency: 'MXN',
          gateway_reference_id: 'ord_conekta_123',
        }]])
        .mockResolvedValueOnce([[{ id: 60, total: '1000.00' }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'conekta',
        providerEventId: 'evt_conekta_1',
        eventType: 'order.paid',
        payload,
      });

      expect(result.status).toBe('processed');
      expect(result.newStatus).toBe('succeeded');
    });

    test('processes Conekta order.payment_failed event', async () => {
      const payload = {
        id: 'evt_conekta_2',
        type: 'order.payment_failed',
        data: { object: { id: 'ord_conekta_fail' } },
      };

      db.query
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ insertId: 21 }])
        .mockResolvedValueOnce([[{
          id: 201, client_id: 10, organization_id: 50,
          gateway_reference_id: 'ord_conekta_fail',
        }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      const result = await paymentGatewayService.handleWebhookEvent({
        provider: 'conekta',
        providerEventId: 'evt_conekta_2',
        eventType: 'order.payment_failed',
        payload,
      });

      expect(result.status).toBe('processed');
      expect(result.newStatus).toBe('failed');
    });

    test('marks event as failed on processing error', async () => {
      db.query
        .mockResolvedValueOnce([[]])                 // No duplicate
        .mockResolvedValueOnce([{ insertId: 16 }])   // INSERT webhook_events
        .mockRejectedValueOnce(new Error('DB error')) // Transaction lookup fails
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE event to failed

      await expect(paymentGatewayService.handleWebhookEvent({
        provider: 'stripe',
        providerEventId: 'evt_error',
        eventType: 'payment_intent.succeeded',
        payload: { id: 'evt_error', type: 'payment_intent.succeeded', data: { object: { id: 'pi_err' } } },
      })).rejects.toThrow('DB error');
    });
  });

  // =========================================================================
  // Auto-reconciliation
  // =========================================================================
  // Rewritten for BIL-05. The old tests encoded the defect: reconcile only
  // flipped invoices.status and wrote a 'payment_transaction' ledger credit, so
  // no payment/allocation ever existed (no REP, no reconnect, no portal
  // history), a capture with no same-amount issued invoice was silently
  // dropped, and errors were swallowed so nothing retried. The detailed
  // behaviour lives in tests/gatewayPaymentReconcile.test.js; these keep the
  // contract visible next to the webhook tests.
  describe('reconcilePayment()', () => {
    // SQL-routing connection: answers by statement, tracks inserted allocations.
    function routeConn({ tx, invoices = [], legacy = [], failOn } = {}) {
      let nextId = 900;
      const allocated = {};
      mockConnection.execute.mockImplementation(async (sql, params) => {
        if (failOn && failOn.test(sql)) throw new Error('DB error');
        if (/FROM payment_transactions WHERE id = \? FOR UPDATE/.test(sql)) return [tx ? [tx] : []];
        if (/FROM client_balance_ledger/.test(sql)) return [legacy];
        if (/FROM payment_gateways/.test(sql)) return [[{ provider: 'stripe' }]];
        if (/FROM invoices i/.test(sql)) return [invoices];
        if (/INSERT INTO payment_allocations/.test(sql)) {
          allocated[params[1]] = (allocated[params[1]] || 0) + params[2];
          return [{ insertId: ++nextId }];
        }
        if (/SUM\(amount\) AS total_allocated/.test(sql)) return [[{ total_allocated: String(allocated[params[0]] || 0) }]];
        if (/^\s*INSERT/.test(sql)) return [{ insertId: ++nextId }];
        return [{ affectedRows: 1 }];
      });
      db.query.mockResolvedValue([{ affectedRows: 0 }]); // post-commit side effects
    }
    const calls = (re) => mockConnection.execute.mock.calls.filter((c) => re.test(c[0]));
    const capturedTx = { id: 100, client_id: 5, organization_id: 42, payment_gateway_id: 7, amount: '500.00', currency: 'MXN', gateway_reference_id: 'pi_abc123', gateway_status: 'succeeded', payment_id: null, invoice_id: null };

    test('posts a completed payment, links payment_id, credits the ledger and marks the covered invoice paid', async () => {
      routeConn({ tx: capturedTx, invoices: [{ id: 50, total: '500.00', balance_due: '500.00' }] });

      const res = await paymentGatewayService.reconcilePayment(100);

      expect(res.status).toBe('reconciled');
      const pay = calls(/INSERT INTO payments/)[0];
      expect(pay[1]).toEqual(expect.arrayContaining([42, 5, '500.00', 'MXN', 'card', '04', 'pi_abc123']));
      expect(calls(/UPDATE payment_transactions SET payment_id = \?/)[0][1]).toEqual([res.paymentId, 100]);
      expect(calls(/INSERT INTO client_balance_ledger/)[0][1]).toEqual(expect.arrayContaining([5, 42, '500.00', 'MXN', res.paymentId]));
      expect(calls(/INSERT INTO payment_allocations/)[0][1]).toEqual([res.paymentId, 50, 500]);
      expect(calls(/UPDATE invoices SET status = \?, paid_at = NOW\(\)/)[0][1]).toEqual(['paid', 50]);
      expect(mockConnection.commit).toHaveBeenCalled();
      expect(mockConnection.release).toHaveBeenCalled();
    });

    test('with no payable invoice the capture is still posted, kept as client credit (was silently dropped)', async () => {
      routeConn({ tx: capturedTx, invoices: [] });
      const res = await paymentGatewayService.reconcilePayment(100);
      expect(res).toMatchObject({ status: 'reconciled', remainingCredit: 500 });
      expect(calls(/INSERT INTO payments/)).toHaveLength(1);
      expect(calls(/INSERT INTO payment_allocations/)).toHaveLength(0);
      expect(mockConnection.commit).toHaveBeenCalled();
    });

    test('amounts that differ are applied up to the balance due, the rest stays as credit (was skipped)', async () => {
      routeConn({ tx: capturedTx, invoices: [{ id: 50, total: '750.00', balance_due: '750.00' }] });
      const res = await paymentGatewayService.reconcilePayment(100);
      expect(calls(/INSERT INTO payment_allocations/)[0][1]).toEqual([res.paymentId, 50, 500]);
      expect(calls(/UPDATE invoices SET status = \?, paid_at/)).toHaveLength(0); // 500 of 750: not paid yet
      expect(res.remainingCredit).toBe(0);
    });

    test('skips reconciliation when transaction not found', async () => {
      routeConn({ tx: null });
      await expect(paymentGatewayService.reconcilePayment(999)).resolves.toEqual({ status: 'not_found' });
      expect(mockConnection.execute).toHaveBeenCalledTimes(1);
      expect(mockConnection.rollback).toHaveBeenCalled();
      expect(mockConnection.release).toHaveBeenCalled();
    });

    test('rolls back and THROWS on a reconciliation error so the webhook/sweep retries (was swallowed)', async () => {
      routeConn({ tx: capturedTx, invoices: [], failOn: /INSERT INTO payments/ });
      await expect(paymentGatewayService.reconcilePayment(100)).rejects.toThrow('DB error');
      expect(mockConnection.rollback).toHaveBeenCalled();
      expect(mockConnection.commit).not.toHaveBeenCalled();
      expect(mockConnection.release).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Webhook Route Integration (supertest)
  // =========================================================================
  describe('Webhook Routes', () => {
    // The routes use the same db mock defined at the top of this file.
    // We test the Express routes via supertest with the mocked database.
    const request = require('supertest');
    const app = require('../src/app');

    // The endpoints fail closed when no signing secret is configured. Most
    // route tests below exercise the processing pipeline without a secret, so
    // they run in the explicit opt-in mode (ALLOW_UNSIGNED_WEBHOOKS). The
    // dedicated fail-closed / signed / malformed tests override this locally.
    beforeEach(() => { process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true'; });
    afterEach(() => { delete process.env.ALLOW_UNSIGNED_WEBHOOKS; });

    test('POST /api/payment-webhooks/stripe returns 200 on valid event', async () => {
      db.query
        .mockResolvedValueOnce([[]])                 // No duplicate
        .mockResolvedValueOnce([{ insertId: 1 }])    // INSERT webhook_events
        .mockResolvedValueOnce([[]])                  // No matching transaction
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE event

      const payload = {
        id: 'evt_test_1',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_test_1' } },
      };

      const res = await request(app)
        .post('/api/payment-webhooks/stripe')
        .send(payload)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('POST /api/payment-webhooks/conekta returns 200 on valid event', async () => {
      db.query
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ insertId: 2 }])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      const payload = {
        id: 'evt_conekta_test_1',
        type: 'order.paid',
        data: { object: { id: 'ord_test_1' } },
      };

      const res = await request(app)
        .post('/api/payment-webhooks/conekta')
        .send(payload)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    test('POST /api/payment-webhooks/stripe rejects invalid signature when secret is set', async () => {
      const originalEnv = process.env.STRIPE_WEBHOOK_SECRET;
      try {
        process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test123';

        const payload = {
          id: 'evt_test_sig',
          type: 'payment_intent.succeeded',
          data: { object: { id: 'pi_test' } },
        };

        const res = await request(app)
          .post('/api/payment-webhooks/stripe')
          .send(payload)
          .set('Content-Type', 'application/json')
          .set('Stripe-Signature', 'invalid_signature');

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      } finally {
        if (originalEnv === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
        else process.env.STRIPE_WEBHOOK_SECRET = originalEnv;
      }
    });

    test('POST /api/payment-webhooks/conekta rejects invalid signature when the public key is set', async () => {
      const originalEnv = process.env.CONEKTA_WEBHOOK_KEY;
      try {
        process.env.CONEKTA_WEBHOOK_KEY = CONEKTA_PUBLIC_PEM;

        const payload = {
          id: 'evt_conekta_sig',
          type: 'order.paid',
          data: { object: { id: 'ord_test' } },
        };

        const res = await request(app)
          .post('/api/payment-webhooks/conekta')
          .send(payload)
          .set('Content-Type', 'application/json')
          .set('Digest', 'invalid_digest');

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      } finally {
        if (originalEnv === undefined) delete process.env.CONEKTA_WEBHOOK_KEY;
        else process.env.CONEKTA_WEBHOOK_KEY = originalEnv;
      }
    });

    test('POST /api/payment-webhooks/stripe returns 200 for duplicate events', async () => {
      db.query.mockResolvedValueOnce([[{ id: 10, status: 'processed' }]]);

      const payload = {
        id: 'evt_dup_route',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_dup' } },
      };

      const res = await request(app)
        .post('/api/payment-webhooks/stripe')
        .send(payload)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('duplicate');
    });

    test('POST /api/payment-webhooks/stripe returns 500 on processing error', async () => {
      db.query
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ insertId: 99 }])
        .mockRejectedValueOnce(new Error('DB failure'))
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      const payload = {
        id: 'evt_error_route',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_err_route' } },
      };

      const res = await request(app)
        .post('/api/payment-webhooks/stripe')
        .send(payload)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('WEBHOOK_PROCESSING_ERROR');
    });

    // -----------------------------------------------------------------------
    // Fail-closed posture (the DAST-surfaced hardening)
    // -----------------------------------------------------------------------
    test('fails closed with 503 when no signing secret is configured', async () => {
      delete process.env.ALLOW_UNSIGNED_WEBHOOKS;              // opt-in OFF
      const orig = process.env.STRIPE_WEBHOOK_SECRET;
      delete process.env.STRIPE_WEBHOOK_SECRET;                // no secret
      try {
        const res = await request(app)
          .post('/api/payment-webhooks/stripe')
          .send({ id: 'evt_noconf', type: 'payment_intent.succeeded', data: { object: {} } })
          .set('Content-Type', 'application/json');

        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('WEBHOOK_NOT_CONFIGURED');
        // Must reject before touching the database.
        expect(db.query).not.toHaveBeenCalled();
      } finally {
        if (orig !== undefined) process.env.STRIPE_WEBHOOK_SECRET = orig;
      }
    });

    test('Conekta fails closed with 503 when no signing key is configured', async () => {
      delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
      const orig = process.env.CONEKTA_WEBHOOK_KEY;
      delete process.env.CONEKTA_WEBHOOK_KEY;
      try {
        const res = await request(app)
          .post('/api/payment-webhooks/conekta')
          .send({ id: 'evt_noconf_c', type: 'order.paid', data: { object: {} } })
          .set('Content-Type', 'application/json');

        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('WEBHOOK_NOT_CONFIGURED');
        expect(db.query).not.toHaveBeenCalled();
      } finally {
        if (orig !== undefined) process.env.CONEKTA_WEBHOOK_KEY = orig;
      }
    });

    test('production ignores ALLOW_UNSIGNED_WEBHOOKS and still fails closed', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';
      delete process.env.STRIPE_WEBHOOK_SECRET;

      try {
        const res = await request(app)
          .post('/api/payment-webhooks/stripe')
          .send({ id: 'evt_prod_unsigned', type: 'payment_intent.succeeded', data: { object: {} } })
          .set('Content-Type', 'application/json');

        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('WEBHOOK_NOT_CONFIGURED');
        expect(db.query).not.toHaveBeenCalled();
      } finally {
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
        if (originalSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
        else process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
      }
    });

    test('accepts a validly SIGNED event (no opt-in needed)', async () => {
      delete process.env.ALLOW_UNSIGNED_WEBHOOKS;              // prove signature alone suffices
      const secret = 'whsec_route_ok';
      const orig = process.env.STRIPE_WEBHOOK_SECRET;
      process.env.STRIPE_WEBHOOK_SECRET = secret;
      try {
        db.query
          .mockResolvedValueOnce([[]])                 // No duplicate
          .mockResolvedValueOnce([{ insertId: 1 }])    // INSERT webhook_events
          .mockResolvedValueOnce([[]])                  // No matching transaction
          .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE event

        const payload = { id: 'evt_signed_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_signed_1' } } };
        const body = JSON.stringify(payload);
        const ts = Math.floor(Date.now() / 1000);
        const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');

        const res = await request(app)
          .post('/api/payment-webhooks/stripe')
          .set('Content-Type', 'application/json')
          .set('Stripe-Signature', `t=${ts},v1=${sig}`)
          .send(body);   // send the exact string so req.rawBody matches the signature

        expect(res.status).toBe(200);
        expect(res.body.received).toBe(true);
      } finally {
        if (orig === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
        else process.env.STRIPE_WEBHOOK_SECRET = orig;
      }
    });

    // -----------------------------------------------------------------------
    // Malformed payload → 400 (not a 500) — the DAST WARN root cause
    // -----------------------------------------------------------------------
    test('rejects a malformed payload (missing id/type) with 400, no DB access', async () => {
      // opt-in ON (from beforeEach), no secret — reaches the shape check
      delete process.env.STRIPE_WEBHOOK_SECRET;
      const res = await request(app)
        .post('/api/payment-webhooks/stripe')
        .send({ foo: 'bar' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WEBHOOK_INVALID_PAYLOAD');
      expect(db.query).not.toHaveBeenCalled();
    });

    test('Conekta rejects a malformed payload with 400', async () => {
      delete process.env.CONEKTA_WEBHOOK_KEY;
      const res = await request(app)
        .post('/api/payment-webhooks/conekta')
        .send([1, 2, 3])   // array, not an event object
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WEBHOOK_INVALID_PAYLOAD');
      expect(db.query).not.toHaveBeenCalled();
    });

    // Symmetry with the Stripe signed test: prove Conekta's real digest path
    // through the Express route (not just the verifyConektaSignature unit), so a
    // Conekta-specific wiring break (wrong header/key/verify) is caught.
    test('Conekta accepts a validly SIGNED event (no opt-in needed)', async () => {
      delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
      const orig = process.env.CONEKTA_WEBHOOK_KEY;
      // Env form: the PEM with literal \n escapes, as it fits on one .env line.
      process.env.CONEKTA_WEBHOOK_KEY = CONEKTA_PUBLIC_PEM.replace(/\n/g, '\\n');
      try {
        db.query
          .mockResolvedValueOnce([[]])                 // No duplicate
          .mockResolvedValueOnce([{ insertId: 3 }])    // INSERT webhook_events
          .mockResolvedValueOnce([[]])                  // No matching transaction
          .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE event

        const payload = { id: 'evt_conekta_signed_1', type: 'order.paid', data: { object: { id: 'ord_signed_1' } } };
        const body = JSON.stringify(payload);
        const digest = conektaDigest(body);

        const res = await request(app)
          .post('/api/payment-webhooks/conekta')
          .set('Content-Type', 'application/json')
          .set('Digest', digest)     // real RSA-SHA256 signature over the exact rawBody
          .send(body);

        expect(res.status).toBe(200);
        expect(res.body.received).toBe(true);
      } finally {
        if (orig === undefined) delete process.env.CONEKTA_WEBHOOK_KEY;
        else process.env.CONEKTA_WEBHOOK_KEY = orig;
      }
    });

    // A validly-SIGNED but malformed body must still 400 (shape check is
    // auth-path-agnostic) — guards a refactor that special-cases the shape
    // check inside the unsigned-only branch and re-introduces the 500.
    test('a validly signed but malformed event still returns 400 (not 500)', async () => {
      delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
      const secret = 'whsec_signed_malformed';
      const orig = process.env.STRIPE_WEBHOOK_SECRET;
      process.env.STRIPE_WEBHOOK_SECRET = secret;
      try {
        const body = JSON.stringify({ notAnEvent: true });   // no id/type
        const ts = Math.floor(Date.now() / 1000);
        const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');

        const res = await request(app)
          .post('/api/payment-webhooks/stripe')
          .set('Content-Type', 'application/json')
          .set('Stripe-Signature', `t=${ts},v1=${sig}`)
          .send(body);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('WEBHOOK_INVALID_PAYLOAD');
        expect(db.query).not.toHaveBeenCalled();   // rejected before any processing
      } finally {
        if (orig === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
        else process.env.STRIPE_WEBHOOK_SECRET = orig;
      }
    });
  });

  // =========================================================================
  // Per-gateway (multi-tenant) webhook routes — secret from the DB, event
  // reconciled only against that tenant
  // =========================================================================
  describe('Gateway-scoped webhook routes', () => {
    const request = require('supertest');
    const app = require('../src/app');

    beforeEach(() => { delete process.env.ALLOW_UNSIGNED_WEBHOOKS; });
    // db.query uses mockImplementation here; reset it so the persistent impl
    // does not leak into later describes (clearAllMocks does not clear impls).
    afterEach(() => { delete process.env.ALLOW_UNSIGNED_WEBHOOKS; db.query.mockReset(); });

    test('verifies with the gateway DB secret and reconciles scoped to that org', async () => {
      db.query.mockImplementation(async (sql) => {
        if (/FROM payment_gateways/.test(sql)) return [[{ id: 7, organization_id: 5, webhook_secret_encrypted: 'whsec_gw7' }]];
        if (/FROM webhook_events/.test(sql)) return [[]];              // no duplicate
        if (/INSERT INTO webhook_events/.test(sql)) return [{ insertId: 42 }];
        if (/FROM payment_transactions/.test(sql)) return [[]];        // no tx for this org → no_match
        if (/UPDATE webhook_events/.test(sql)) return [{ affectedRows: 1 }];
        return [[]];
      });

      const payload = { id: 'evt_gw_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_gw_1' } } };
      const body = JSON.stringify(payload);
      const ts = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac('sha256', 'whsec_gw7').update(`${ts}.${body}`, 'utf8').digest('hex');

      const res = await request(app)
        .post('/api/payment-webhooks/stripe/7')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', `t=${ts},v1=${sig}`)
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
      // the gateway row was loaded by (id, provider)
      const gwCall = db.query.mock.calls.find(c => /FROM payment_gateways/.test(c[0]));
      expect(gwCall[1]).toEqual(['7', 'stripe']);
      // the transaction lookup was CONFINED to the gateway's org (cross-tenant guard)
      const txCall = db.query.mock.calls.find(c => /FROM payment_transactions/.test(c[0]));
      expect(txCall[0]).toMatch(/organization_id = \?/);
      expect(txCall[1]).toEqual(['pi_gw_1', 5]);
    });

    test('unknown / inactive gateway → 404, nothing processed', async () => {
      db.query.mockImplementation(async (sql) => (/FROM payment_gateways/.test(sql) ? [[]] : [[]]));
      const res = await request(app)
        .post('/api/payment-webhooks/stripe/999')
        .send({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('WEBHOOK_GATEWAY_NOT_FOUND');
      expect(db.query.mock.calls.some(c => /webhook_events/.test(c[0]))).toBe(false);
    });

    test('non-numeric gatewayId → 404 without touching the database', async () => {
      db.query.mockImplementation(async () => [[]]);
      const res = await request(app)
        .post('/api/payment-webhooks/stripe/not-a-number')
        .send({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('WEBHOOK_GATEWAY_NOT_FOUND');
      expect(db.query).not.toHaveBeenCalled();
    });

    test('gateway exists but has no webhook secret → 503 (fail closed)', async () => {
      db.query.mockImplementation(async (sql) => (/FROM payment_gateways/.test(sql)
        ? [[{ id: 7, organization_id: 5, webhook_secret_encrypted: null }]] : [[]]));
      const res = await request(app)
        .post('/api/payment-webhooks/stripe/7')
        .send({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('WEBHOOK_NOT_CONFIGURED');
      expect(db.query.mock.calls.some(c => /webhook_events/.test(c[0]))).toBe(false);
    });

    test('gateway secret set but signature invalid → 401', async () => {
      db.query.mockImplementation(async (sql) => (/FROM payment_gateways/.test(sql)
        ? [[{ id: 7, organization_id: 5, webhook_secret_encrypted: 'whsec_gw7' }]] : [[]]));
      const res = await request(app)
        .post('/api/payment-webhooks/stripe/7')
        .send({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } })
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', 't=1,v1=deadbeef');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    });

    test('Conekta gateway route verifies with the DB key', async () => {
      db.query.mockImplementation(async (sql) => {
        if (/FROM payment_gateways/.test(sql)) return [[{ id: 9, organization_id: 6, webhook_secret_encrypted: CONEKTA_PUBLIC_PEM }]];
        if (/FROM webhook_events/.test(sql)) return [[]];
        if (/INSERT INTO webhook_events/.test(sql)) return [{ insertId: 50 }];
        if (/FROM payment_transactions/.test(sql)) return [[]];
        if (/UPDATE webhook_events/.test(sql)) return [{ affectedRows: 1 }];
        return [[]];
      });

      const payload = { id: 'evt_conekta_gw_1', type: 'order.paid', data: { object: { id: 'ord_gw_1' } } };
      const body = JSON.stringify(payload);
      const digest = conektaDigest(body);

      const res = await request(app)
        .post('/api/payment-webhooks/conekta/9')
        .set('Content-Type', 'application/json')
        .set('Digest', digest)
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
      const gwCall = db.query.mock.calls.find(c => /FROM payment_gateways/.test(c[0]));
      expect(gwCall[1]).toEqual(['9', 'conekta']);
    });

    test('Conekta unknown gateway → 404', async () => {
      db.query.mockImplementation(async () => [[]]);
      const res = await request(app)
        .post('/api/payment-webhooks/conekta/404')
        .send({ id: 'evt_x', type: 'order.paid', data: { object: { id: 'ord_x' } } })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('WEBHOOK_GATEWAY_NOT_FOUND');
    });

    test('Conekta gateway without a webhook key → 503', async () => {
      db.query.mockImplementation(async (sql) => (/FROM payment_gateways/.test(sql)
        ? [[{ id: 9, organization_id: 6, webhook_secret_encrypted: null }]] : [[]]));
      const res = await request(app)
        .post('/api/payment-webhooks/conekta/9')
        .send({ id: 'evt_x', type: 'order.paid', data: { object: { id: 'ord_x' } } })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('WEBHOOK_NOT_CONFIGURED');
      expect(db.query.mock.calls.some(c => /webhook_events/.test(c[0]))).toBe(false);
    });

    test('Conekta gateway key set but digest invalid → 401', async () => {
      db.query.mockImplementation(async (sql) => (/FROM payment_gateways/.test(sql)
        ? [[{ id: 9, organization_id: 6, webhook_secret_encrypted: CONEKTA_PUBLIC_PEM }]] : [[]]));
      const res = await request(app)
        .post('/api/payment-webhooks/conekta/9')
        .send({ id: 'evt_x', type: 'order.paid', data: { object: { id: 'ord_x' } } })
        .set('Content-Type', 'application/json')
        .set('Digest', 'not-a-valid-digest');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    });

    test('Conekta digest signed by a different key → 401', async () => {
      db.query.mockImplementation(async (sql) => (/FROM payment_gateways/.test(sql)
        ? [[{ id: 9, organization_id: 6, webhook_secret_encrypted: CONEKTA_PUBLIC_PEM }]] : [[]]));
      const intruder = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const body = JSON.stringify({ id: 'evt_forged', type: 'order.paid', data: { object: { id: 'ord_x' } } });
      const res = await request(app)
        .post('/api/payment-webhooks/conekta/9')
        .set('Content-Type', 'application/json')
        .set('Digest', crypto.sign('RSA-SHA256', Buffer.from(body), intruder.privateKey).toString('base64'))
        .send(body);
      expect(res.status).toBe(401);
      expect(db.query.mock.calls.some(c => /webhook_events/.test(c[0]))).toBe(false);
    });

    // An old HMAC-style shared secret stored before BIL-25 can never verify a
    // Conekta signature. Fail closed as "not configured" (operator action),
    // never process, and never answer a misleading 401.
    test('Conekta gateway configured with a non-PEM secret → 503, nothing processed', async () => {
      db.query.mockImplementation(async (sql) => (/FROM payment_gateways/.test(sql)
        ? [[{ id: 9, organization_id: 6, webhook_secret_encrypted: 'conekta_gw9' }]] : [[]]));
      const body = JSON.stringify({ id: 'evt_x', type: 'order.paid', data: { object: { id: 'ord_x' } } });
      const res = await request(app)
        .post('/api/payment-webhooks/conekta/9')
        .set('Content-Type', 'application/json')
        .set('Digest', crypto.createHmac('sha256', 'conekta_gw9').update(body, 'utf8').digest('hex'))
        .send(body);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('WEBHOOK_NOT_CONFIGURED');
      expect(db.query.mock.calls.some(c => /webhook_events/.test(c[0]))).toBe(false);
    });
  });

  // =========================================================================
  // loadGatewayWebhookContext() unit
  // =========================================================================
  describe('loadGatewayWebhookContext()', () => {
    test('non-numeric gatewayId returns not-found without a query', async () => {
      const ctx = await paymentGatewayService.loadGatewayWebhookContext({ provider: 'stripe', gatewayId: 'abc' });
      expect(ctx).toEqual({ found: false });
      expect(db.query).not.toHaveBeenCalled();
    });

    test('returns the decrypted secret + org for a matching active gateway', async () => {
      db.query.mockResolvedValueOnce([[{ id: 7, organization_id: 5, webhook_secret_encrypted: 'whsec_plain' }]]);
      const ctx = await paymentGatewayService.loadGatewayWebhookContext({ provider: 'stripe', gatewayId: '7' });
      expect(ctx).toEqual({ found: true, organizationId: 5, webhookSecret: 'whsec_plain' });
      // scoped by id + provider + active + not-deleted
      expect(db.query.mock.calls[0][0]).toMatch(/provider = \? AND status = 'active' AND deleted_at IS NULL/);
      expect(db.query.mock.calls[0][1]).toEqual(['7', 'stripe']);
    });

    test('gateway without a webhook secret → webhookSecret null', async () => {
      db.query.mockResolvedValueOnce([[{ id: 7, organization_id: 5, webhook_secret_encrypted: null }]]);
      const ctx = await paymentGatewayService.loadGatewayWebhookContext({ provider: 'stripe', gatewayId: '7' });
      expect(ctx).toEqual({ found: true, organizationId: 5, webhookSecret: null });
    });

    test('undecryptable secret (ciphertext-shaped, returned unchanged) → unconfigured, not a 500 or a misleading 401', async () => {
      // A real iv:tag:ct blob that no longer decrypts (rotated/lost key): the
      // real decrypt() returns it UNCHANGED. The loader must treat that as
      // unconfigured (503), not run verification against ciphertext (401).
      const undecryptable = `${'0'.repeat(24)}:${'0'.repeat(32)}:deadbeefcafe`;
      db.query.mockResolvedValueOnce([[{ id: 7, organization_id: 5, webhook_secret_encrypted: undecryptable }]]);
      const ctx = await paymentGatewayService.loadGatewayWebhookContext({ provider: 'stripe', gatewayId: '7' });
      expect(ctx).toEqual({ found: true, organizationId: 5, webhookSecret: null });
    });

    test('no matching row → not found', async () => {
      db.query.mockResolvedValueOnce([[]]);
      const ctx = await paymentGatewayService.loadGatewayWebhookContext({ provider: 'stripe', gatewayId: '7' });
      expect(ctx).toEqual({ found: false });
    });
  });
});
