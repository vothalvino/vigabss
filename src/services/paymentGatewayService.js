// =============================================================================
// VigaBSS 5.0 — Payment Gateway Service
// =============================================================================
// Abstracts payment processing through configured gateways.
// Supports Stripe, Conekta, and generic card processing.
// Includes idempotency, webhook signature verification, and reconciliation.
// =============================================================================

const crypto = require('crypto');
const db = require('../config/database');
const { creditAppliedSql } = require('../utils/invoiceBalance');
const { URLSearchParams } = require('url');
const { createCircuitBreaker } = require('../utils/circuitBreaker');
const { decrypt, isConfigured: isEncryptionConfigured } = require('../utils/encryption');
const logger = require('../utils/logger');
const { PaymentGatewayError, ValidationError } = require('../utils/errors');

// Default idempotency key TTL: 24 hours
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

// Circuit breaker for external payment gateway calls (Stripe, Conekta)
const paymentCircuitBreaker = createCircuitBreaker({
  name: 'PaymentGateway',
  threshold: 5,
  resetMs: 60000,
});

/**
 * Get the active payment gateway for an organization: the default one first,
 * then the oldest. A soft-deleted gateway is never live, whatever its status.
 */
async function getActiveGateway(organizationId) {
  const [rows] = await db.query(
    `SELECT * FROM payment_gateways
      WHERE organization_id = ? AND status = 'active' AND deleted_at IS NULL
      ORDER BY is_default DESC, id ASC LIMIT 1`,
    [organizationId],
  );
  return rows[0] || null;
}

/**
 * Load one specific live gateway of an organization (active, not deleted).
 * Used for charges that must go through the gateway that issued a stored
 * token (autopay, retries) rather than whichever gateway happens to be first.
 */
async function getGatewayById(organizationId, gatewayId) {
  const [rows] = await db.query(
    `SELECT * FROM payment_gateways
      WHERE id = ? AND organization_id = ? AND status = 'active' AND deleted_at IS NULL
      LIMIT 1`,
    [gatewayId, organizationId],
  );
  return rows[0] || null;
}

// Providers that can charge a stored card without the customer present.
// 'manual' and 'other' move no money; Conekta's charge path does not use the
// stored payment source yet, so an off-session Conekta charge would not
// collect from the saved card either.
const OFF_SESSION_PROVIDERS = ['stripe'];

/**
 * Resolve the per-gateway webhook context for an inbound, provider-scoped
 * webhook (POST /payment-webhooks/:provider/:gatewayId). The gatewayId comes
 * from the (untrusted) URL, so the row must match the provider on the path and
 * be active. Returns:
 *   { found:false }                                   → unknown/inactive/wrong-provider gateway (404)
 *   { found:true, organizationId, webhookSecret:null} → gateway exists but no webhook secret set (503)
 *   { found:true, organizationId, webhookSecret:'…' } → ready to verify
 * A secret that cannot be decrypted (corrupt ciphertext / wrong key) is treated
 * as not-configured rather than surfacing a 500.
 *
 * @param {object} params
 * @param {string} params.provider   - 'stripe' | 'conekta'
 * @param {number|string} params.gatewayId
 */
async function loadGatewayWebhookContext({ provider, gatewayId, organizationId }) {
  if (!/^\d+$/.test(String(gatewayId))) return { found: false };
  const scoped = organizationId !== undefined && organizationId !== null;

  const [rows] = await db.query(
    `SELECT id, organization_id, webhook_secret_encrypted
       FROM payment_gateways
      WHERE id = ? AND provider = ? AND status = 'active' AND deleted_at IS NULL
        ${scoped ? 'AND organization_id = ?' : ''}
      LIMIT 1`,
    scoped ? [gatewayId, provider, organizationId] : [gatewayId, provider],
  );
  if (rows.length === 0) return { found: false };

  const gw = rows[0];
  const stored = gw.webhook_secret_encrypted;
  if (!stored) {
    return { found: true, organizationId: gw.organization_id, webhookSecret: null };
  }

  let webhookSecret;
  try {
    webhookSecret = decrypt(stored);
  } catch (err) {
    // Only getKey() (malformed ENCRYPTION_KEY) throws here; a corrupt/rotated
    // ciphertext does NOT — see below.
    logger.error({ err, gatewayId: gw.id, provider }, 'Failed to decrypt gateway webhook secret');
    return { found: true, organizationId: gw.organization_id, webhookSecret: null };
  }

  // decrypt() returns the input UNCHANGED (never throws) when it cannot decrypt
  // a value — wrong/rotated ENCRYPTION_KEY or corrupt bytes. If the stored value
  // is in our ciphertext shape and came back unchanged while encryption is
  // configured, it is genuinely undecryptable: fail closed (503) rather than run
  // signature verification against ciphertext and mislead with a 401.
  if (isEncryptionConfigured() && looksLikeCiphertext(stored) && webhookSecret === stored) {
    logger.error({ gatewayId: gw.id, provider }, 'Gateway webhook secret is undecryptable (wrong/rotated ENCRYPTION_KEY?) — treating as unconfigured');
    return { found: true, organizationId: gw.organization_id, webhookSecret: null };
  }

  return { found: true, organizationId: gw.organization_id, webhookSecret };
}

// Our AES-256-GCM envelope format: hex(iv=12B):hex(tag=16B):hex(ciphertext).
const CIPHERTEXT_RE = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i;
function looksLikeCiphertext(v) {
  return typeof v === 'string' && CIPHERTEXT_RE.test(v);
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Check for an existing idempotency key. Returns the cached response or null.
 */
async function checkIdempotencyKey(organizationId, key) {
  const [rows] = await db.query(
    `SELECT * FROM idempotency_keys
     WHERE organization_id = ? AND idempotency_key = ? AND expires_at > NOW()
     LIMIT 1`,
    [organizationId, key],
  );
  return rows[0] || null;
}

/**
 * Store the result of a charge request under an idempotency key.
 */
async function storeIdempotencyKey(organizationId, key, statusCode, responseBody) {
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
  await db.query(
    `INSERT INTO idempotency_keys (organization_id, idempotency_key, status, response_code, response_body, expires_at)
     VALUES (?, ?, 'completed', ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = 'completed', response_code = VALUES(response_code),
       response_body = VALUES(response_body), expires_at = VALUES(expires_at)`,
    [organizationId, key, statusCode, JSON.stringify(responseBody), expiresAt],
  );
}

/**
 * Charge a payment through the gateway with optional idempotency.
 * If an idempotencyKey is provided and a cached result exists, the cached
 * result is returned instead of charging again.
 */
async function charge({ organizationId, gatewayId, clientId, amount, currency, description, paymentMethodToken, customer, offSession, invoiceId, idempotencyKey }) {
  // --- Idempotency check ---
  if (idempotencyKey) {
    const cached = await checkIdempotencyKey(organizationId, idempotencyKey);
    if (cached && cached.status === 'completed') {
      const body = typeof cached.response_body === 'string'
        ? JSON.parse(cached.response_body)
        : cached.response_body;
      return { ...body, idempotent_replay: true };
    }
  }

  // A charge against a stored token must use the gateway that issued it.
  const gateway = gatewayId
    ? await getGatewayById(organizationId, gatewayId)
    : await getActiveGateway(organizationId);
  if (!gateway) {
    throw new Error(gatewayId
      ? 'The payment gateway for this payment method is no longer active'
      : 'No active payment gateway configured');
  }
  if (offSession && !OFF_SESSION_PROVIDERS.includes(gateway.provider)) {
    throw new PaymentGatewayError(
      `Payment provider '${gateway.provider}' cannot charge a stored payment method automatically`,
    );
  }

  // Column is `payment_gateway_id`; there is no `description` column. And
  // `gateway_reference_id` is NOT NULL even though the provider only assigns the
  // real reference *after* the charge succeeds (it is overwritten below, and by
  // the webhook handler), so the pending row carries a provisional reference.
  // The description survives in raw_request.
  const provisionalRef = `pending:${idempotencyKey || crypto.randomUUID()}`;
  // invoice_id links the charge to the exact invoice it settles (autopay / any
  // caller that knows the target) so reconcilePayment credits THAT invoice via
  // the explicit-linkage path instead of the oldest-issued-amount heuristic,
  // which mis-attributes when a client has two equal-total issued invoices.
  const [txResult] = await db.query(
    `INSERT INTO payment_transactions
     (organization_id, payment_gateway_id, client_id, amount, currency,
      gateway_reference_id, gateway_status, invoice_id, idempotency_key, raw_request)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [organizationId, gateway.id, clientId, amount, currency || 'MXN',
      provisionalRef, invoiceId || null, idempotencyKey || null,
      JSON.stringify({ description: description || null, amount, currency: currency || 'MXN' })],
  );

  const transactionId = txResult.insertId;

  try {
    let result;

    switch (gateway.provider) {
      case 'stripe':
        result = await paymentCircuitBreaker.call(() =>
          chargeStripe(gateway, amount, currency || 'MXN', description, paymentMethodToken, { customer, offSession, idempotencyKey }));
        break;
      case 'conekta':
        result = await paymentCircuitBreaker.call(() =>
          chargeConekta(gateway, amount, currency || 'MXN', description, paymentMethodToken));
        break;
      case 'manual':
        // A manual gateway moves no money, so a "charge" through it must never
        // be recorded as succeeded. Offline payments are recorded with
        // POST /payments instead.
        throw new PaymentGatewayError(
          'A manual payment gateway cannot process charges; record the payment with POST /payments instead',
        );
      default:
        // Provider is configured in the schema but not yet implemented.
        throw new PaymentGatewayError(
          `Payment provider '${gateway.provider}' is not yet supported for automated charges. ` +
          'Use provider \'manual\' to record offline payments, or configure a supported provider (stripe, conekta).',
        );
    }

    await db.query(
      'UPDATE payment_transactions SET gateway_reference_id = ?, gateway_status = ?, raw_response = ? WHERE id = ?',
      [result.gatewayRef, result.status, JSON.stringify(result.rawResponse || null), transactionId],
    );

    const response = {
      transaction_id: transactionId,
      gateway_reference: result.gatewayRef,
      status: result.status,
      provider: gateway.provider,
    };

    // Cache the response under the idempotency key
    if (idempotencyKey) {
      await storeIdempotencyKey(organizationId, idempotencyKey, 200, response);
    }

    return response;
  } catch (err) {
    await db.query(
      'UPDATE payment_transactions SET gateway_status = ?, raw_response = ? WHERE id = ?',
      ['failed', err.message, transactionId],
    );

    const errorResponse = {
      transaction_id: transactionId,
      status: 'failed',
      error: err.message,
    };

    if (idempotencyKey) {
      await storeIdempotencyKey(organizationId, idempotencyKey, 200, errorResponse);
    }

    return errorResponse;
  }
}

/**
 * Charge via Stripe REST API (no SDK — uses built-in https).
 */
async function chargeStripe(gateway, amount, currency, description, paymentMethodToken, options = {}) {
  const https = require('https');

  const secretKey = decrypt(gateway.secret_key_encrypted);
  const params = {
    amount: Math.round(amount * 100).toString(), // Stripe uses cents
    currency: currency.toLowerCase(),
    description: description || 'VigaBSS payment',
  };
  if (paymentMethodToken) {
    params.payment_method = paymentMethodToken;
    params.confirm = 'true';
    // For a saved card (autopay) the PaymentIntent must name the customer and be
    // flagged off_session, or Stripe returns authentication_required and the
    // charge parks in requires_payment_method forever. The mandate that makes
    // off-session legal is collected by the Checkout setup-mode capture flow.
    if (options.customer) params.customer = options.customer;
    if (options.offSession) params.off_session = 'true';
  }
  const body = new URLSearchParams(params).toString();

  const response = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path: '/v1/payment_intents',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        // Stripe dedupes a repeated request with the same key, so a second
        // replica or a retried run for the same invoice/day cannot charge twice.
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('Stripe request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const data = JSON.parse(response.body);
  if (response.statusCode >= 400 || data.error) {
    throw new Error(data.error?.message || `Stripe error: HTTP ${response.statusCode}`);
  }

  return {
    gatewayRef: data.id,
    status: data.status === 'succeeded' ? 'succeeded' : 'pending',
    rawResponse: data,
  };
}

/**
 * Create a Stripe-hosted Checkout Session for a one-time payment and return its
 * id + hosted url. The client is redirected to Stripe; on completion Stripe fires
 * checkout.session.completed, which the webhook reconciles against the pending
 * transaction (matched by gateway_reference_id = the session id).
 */
async function createStripeCheckoutSession(gateway, { amount, currency, description, successUrl, cancelUrl, metadata = {} }) {
  const https = require('https');
  const secretKey = decrypt(gateway.secret_key_encrypted);

  const params = {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': String(currency || 'MXN').toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(Math.round(amount * 100)),
    'line_items[0][price_data][product_data][name]': description || 'VigaBSS payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
  };
  for (const [k, v] of Object.entries(metadata)) {
    if (v !== null && v !== undefined) {
      params[`metadata[${k}]`] = String(v);
      // Copy onto the PaymentIntent too: payment_intent.* and charge.* events
      // carry the PI's metadata, not the session's, and would otherwise not
      // match the pending transaction (WHK-03).
      params[`payment_intent_data[metadata][${k}]`] = String(v);
    }
  }
  const body = new URLSearchParams(params).toString();

  const response = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path: '/v1/checkout/sessions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('Stripe request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const data = JSON.parse(response.body);
  if (response.statusCode >= 400 || data.error) {
    throw new Error(data.error?.message || `Stripe error: HTTP ${response.statusCode}`);
  }
  return { id: data.id, url: data.url };
}

/**
 * Create a Conekta order with an embedded HostedPayment checkout and return the
 * order id + hosted payment page url. The client is redirected to `url`; when the
 * order is paid Conekta fires `order.paid`, which the webhook reconciles against
 * the pending transaction (matched by gateway_reference_id = the order id, with
 * the order's metadata.transaction_id as a fallback). The HostedPayment checkout
 * lets the customer pay by card, cash (OXXO) or bank transfer (SPEI) — the three
 * methods that matter for a Mexican launch.
 *
 * NOTE: built to the Conekta v2.x Orders/Checkout spec (POST /orders with an
 * embedded `checkout`, response `checkout.url`); the live round-trip is not
 * sandbox-verified here (no Conekta test account on hand) — same posture as the
 * Stripe hosted flow, which also needs a real gateway to prove end-to-end.
 */
async function createConektaCheckoutSession(gateway, { amount, currency, description, customerName, customerEmail, customerPhone, successUrl, failureUrl, expiresAt, metadata = {} }) {
  const https = require('https');
  const secretKey = decrypt(gateway.secret_key_encrypted);

  const stringMeta = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (v !== null && v !== undefined) stringMeta[k] = String(v);
  }

  // Send everything we have — some Conekta validations expect name + email +
  // phone on customer_info at order creation; omitting a field we DO have on
  // file risks a 422 on every checkout.
  const customerInfo = { name: customerName || 'Cliente' };
  if (customerEmail) customerInfo.email = customerEmail;
  if (customerPhone) customerInfo.phone = customerPhone;

  const body = JSON.stringify({
    currency: String(currency || 'MXN').toUpperCase(),
    customer_info: customerInfo,
    line_items: [{
      name: (description || 'VigaBSS payment').slice(0, 250),
      unit_price: Math.round(amount * 100), // Conekta uses cents
      quantity: 1,
    }],
    checkout: {
      type: 'HostedPayment',
      name: (description || 'VigaBSS payment').slice(0, 250),
      allowed_payment_methods: ['card', 'cash', 'bank_transfer'],
      success_url: successUrl,
      failure_url: failureUrl || successUrl,
      redirection_time: 5,
      expires_at: Math.floor(expiresAt.getTime() / 1000),
    },
    metadata: stringMeta,
  });

  const response = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.conekta.io',
      path: '/orders',
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(secretKey + ':').toString('base64')}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.conekta-v2.1.0+json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('Conekta request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const data = JSON.parse(response.body);
  if (response.statusCode >= 400 || data.type === 'error') {
    throw new Error(data.details?.[0]?.message || `Conekta error: HTTP ${response.statusCode}`);
  }
  const url = data.checkout?.url;
  if (!url) throw new Error('Conekta did not return a hosted checkout url');
  return { id: data.id, url };
}

// --- Stripe REST helper (shared by the autopay-enrollment calls) ---
function stripeRequest(secretKey, method, path, body) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${secretKey}` };
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request({ hostname: 'api.stripe.com', path, method, headers, timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch (_e) { /* non-JSON */ }
        if (res.statusCode >= 400 || parsed.error) {
          return reject(new Error(parsed.error?.message || `Stripe HTTP ${res.statusCode}`));
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Stripe request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Create a Stripe customer (for off-session autopay). Returns the cus_ id. */
async function createStripeCustomer(gateway, { email, metadata = {} }) {
  const secretKey = decrypt(gateway.secret_key_encrypted);
  const params = {};
  if (email) params.email = email;
  for (const [k, v] of Object.entries(metadata)) {
    if (v !== null && v !== undefined) params[`metadata[${k}]`] = String(v);
  }
  const data = await stripeRequest(secretKey, 'POST', '/v1/customers', new URLSearchParams(params).toString());
  return data.id;
}

/**
 * Create a Stripe Checkout Session in SETUP mode to capture (and get SCA/mandate
 * consent for) a reusable card against a customer. Returns the hosted url.
 */
async function createStripeSetupSession(gateway, { customerId, successUrl, cancelUrl, metadata = {} }) {
  const secretKey = decrypt(gateway.secret_key_encrypted);
  const params = {
    mode: 'setup',
    customer: customerId,
    'payment_method_types[0]': 'card',
    success_url: successUrl,
    cancel_url: cancelUrl,
  };
  for (const [k, v] of Object.entries(metadata)) {
    if (v !== null && v !== undefined) {
      params[`metadata[${k}]`] = String(v);
      params[`setup_intent_data[metadata][${k}]`] = String(v);
    }
  }
  const data = await stripeRequest(secretKey, 'POST', '/v1/checkout/sessions', new URLSearchParams(params).toString());
  return { id: data.id, url: data.url };
}

/**
 * Read a completed Checkout Session, expanding the setup_intent so we can pull
 * the saved payment_method + customer to persist on the autopay profile.
 */
async function retrieveStripeCheckoutSession(gateway, sessionId) {
  const secretKey = decrypt(gateway.secret_key_encrypted);
  // Expand setup_intent.payment_method so we get the card brand/last4/expiry
  // inline (to display "Visa ending 4242" on the autopay card) alongside the pm id.
  const data = await stripeRequest(secretKey, 'GET', `/v1/checkout/sessions/${sessionId}?expand[]=setup_intent.payment_method`, null);
  const pm = data.setup_intent?.payment_method;
  const pmId = typeof pm === 'string' ? pm : (pm?.id || null);
  const card = (pm && typeof pm === 'object') ? pm.card : null;
  return {
    mode: data.mode,
    customer: typeof data.customer === 'string' ? data.customer : (data.customer?.id || null),
    paymentMethod: pmId,
    card: card ? {
      brand: card.brand || null,
      last4: card.last4 || null,
      expMonth: card.exp_month || null,
      expYear: card.exp_year || null,
    } : null,
    metadata: data.metadata || {},
  };
}

/**
 * Charge via Conekta REST API.
 */
async function chargeConekta(gateway, amount, currency, description, _paymentMethodToken) {
  const https = require('https');

  const secretKey = decrypt(gateway.secret_key_encrypted);
  const body = JSON.stringify({
    line_items: [{
      name: description || 'VigaBSS payment',
      unit_price: Math.round(amount * 100), // Conekta uses cents
      quantity: 1,
    }],
    currency: currency.toUpperCase(),
    charges: [{
      payment_method: { type: 'default' },
    }],
  });

  const response = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.conekta.io',
      path: '/orders',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(secretKey + ':').toString('base64')}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.conekta-v2.1.0+json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('Conekta request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const data = JSON.parse(response.body);
  if (response.statusCode >= 400 || data.type === 'error') {
    throw new Error(data.details?.[0]?.message || `Conekta error: HTTP ${response.statusCode}`);
  }

  return {
    gatewayRef: data.id,
    status: data.payment_status === 'paid' ? 'succeeded' : 'pending',
    rawResponse: data,
  };
}

/**
 * Call the Stripe refunds API for a previously-captured charge or payment intent.
 * @param {object} gateway  - payment_gateways row (with secret_key_encrypted)
 * @param {object} tx       - payment_transactions row
 * @param {number} amountMinor - amount to refund in minor units (cents)
 * @returns {Promise<{gatewayRefundRef: string}>}
 */
async function refundStripe(gateway, tx, amountMinor) {
  const https = require('https');

  const secretKey = decrypt(gateway.secret_key_encrypted);
  const body = new URLSearchParams({
    payment_intent: tx.gateway_reference_id,
    amount: String(amountMinor),
  }).toString();

  const response = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path: '/v1/refunds',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('Stripe refund request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const data = JSON.parse(response.body);
  if (response.statusCode >= 400 || data.error) {
    throw new PaymentGatewayError(data.error?.message || `Stripe refund error: HTTP ${response.statusCode}`);
  }

  return { gatewayRefundRef: data.id };
}

/**
 * Call the Conekta order refund API for a previously-created order.
 * @param {object} gateway  - payment_gateways row (with secret_key_encrypted)
 * @param {object} tx       - payment_transactions row
 * @param {number} amountMinor - amount to refund in minor units (cents)
 * @returns {Promise<{gatewayRefundRef: string}>}
 */
async function refundConekta(gateway, tx, amountMinor) {
  const https = require('https');

  const secretKey = decrypt(gateway.secret_key_encrypted);
  const body = JSON.stringify({ reason: 'requested_by_customer', amount: amountMinor });
  const path = `/orders/${tx.gateway_reference_id}/refunds`;

  const response = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.conekta.io',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(secretKey + ':').toString('base64')}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.conekta-v2.1.0+json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('Conekta refund request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const data = JSON.parse(response.body);
  if (response.statusCode >= 400 || data.type === 'error') {
    throw new PaymentGatewayError(
      data.details?.[0]?.message || `Conekta refund error: HTTP ${response.statusCode}`,
    );
  }

  return { gatewayRefundRef: data.id || tx.gateway_reference_id };
}

/**
 * Refund a payment transaction in full.
 *
 * The transaction is loaded within the caller's organization (and client, when
 * given), so a transaction id from another tenant is rejected before any
 * processor call. The requested amount must equal the captured amount: the
 * bookkeeping reversal (reverseRefund) re-opens the settled invoice and debits
 * the full amount, so partial gateway refunds are refused rather than silently
 * refunding everything. The succeeded -> refunded flip is claimed atomically
 * before the processor call, so concurrent requests cannot refund twice; a
 * processor failure restores 'succeeded'.
 *
 * For stripe/conekta: calls the processor with the explicit amount, wrapped in
 * the circuit breaker. For manual: DB-only status flip. For unimplemented
 * providers: throws PaymentGatewayError.
 *
 * @param {number} transactionId
 * @param {object} opts
 * @param {number|null} opts.orgId     required; the caller's organization
 * @param {number} [opts.clientId]     when given, the transaction must belong to it
 * @param {number|string} [opts.amount] requested amount; defaults to the full amount
 * @returns {Promise<{transaction_id: number, status: string, gateway_refund_reference?: string}>}
 */
async function refund(transactionId, { orgId, clientId, amount } = {}) {
  if (orgId === undefined) throw new Error('paymentGatewayService.refund: orgId is required');

  // Fetch transaction and join to the same organization's gateway
  const params = [transactionId, orgId];
  let clientSql = '';
  if (clientId !== undefined && clientId !== null) {
    clientSql = ' AND pt.client_id = ?';
    params.push(clientId);
  }
  const [rows] = await db.query(
    `SELECT pt.*, pg.provider, pg.secret_key_encrypted, pg.config_json
     FROM payment_transactions pt
     JOIN payment_gateways pg ON pg.id = pt.payment_gateway_id
                             AND pg.organization_id = pt.organization_id
     WHERE pt.id = ? AND pt.organization_id <=> ?${clientSql}
     LIMIT 1`,
    params,
  );
  const tx = rows[0];

  if (!tx) throw new ValidationError('Payment transaction not found for this organization and client');
  if (tx.gateway_status !== 'succeeded') throw new ValidationError('Can only refund succeeded transactions');

  const capturedMinor = Math.round(parseFloat(tx.amount) * 100);
  const requestedMinor = amount === undefined || amount === null
    ? capturedMinor
    : Math.round(parseFloat(amount) * 100);
  if (!Number.isFinite(requestedMinor) || requestedMinor <= 0) {
    throw new ValidationError('Refund amount must be greater than zero');
  }
  if (requestedMinor > capturedMinor) {
    throw new ValidationError('Refund amount exceeds the captured transaction amount');
  }
  if (requestedMinor < capturedMinor) {
    throw new ValidationError(
      'Partial gateway refunds are not supported yet. Refund the full transaction amount, '
      + 'or use the credit_balance or manual refund method.',
    );
  }

  // Atomic claim: only one caller can move this transaction out of 'succeeded'.
  const [claim] = await db.query(
    "UPDATE payment_transactions SET gateway_status = 'refunded' WHERE id = ? AND organization_id <=> ? AND gateway_status = 'succeeded'",
    [transactionId, orgId],
  );
  if (!claim || claim.affectedRows !== 1) {
    throw new ValidationError('Transaction is already being refunded or is no longer refundable');
  }

  let gatewayRefundRef = null;
  try {
    switch (tx.provider) {
      case 'stripe': {
        const refundResult = await paymentCircuitBreaker.call(() => refundStripe(tx, tx, requestedMinor));
        gatewayRefundRef = refundResult.gatewayRefundRef;
        break;
      }
      case 'conekta': {
        const refundResult = await paymentCircuitBreaker.call(() => refundConekta(tx, tx, requestedMinor));
        gatewayRefundRef = refundResult.gatewayRefundRef;
        break;
      }
      case 'manual':
        // Offline / manually-recorded payment: DB-only status flip is sufficient.
        break;
      default:
        throw new PaymentGatewayError(
          `Refunds for provider '${tx.provider}' are not yet supported. ` +
          'Process the refund directly with the provider and record it manually.',
        );
    }
  } catch (err) {
    // No money moved: release the claim so the refund can be retried.
    await db.query(
      "UPDATE payment_transactions SET gateway_status = 'succeeded' WHERE id = ? AND organization_id <=> ? AND gateway_status = 'refunded'",
      [transactionId, orgId],
    );
    throw err;
  }

  if (gatewayRefundRef) {
    await db.query(
      'UPDATE payment_transactions SET gateway_reference_id = ? WHERE id = ? AND organization_id <=> ?',
      [gatewayRefundRef, transactionId, orgId],
    );
  }

  // Reverse the bookkeeping: re-open the settled invoice + offset the ledger.
  await reverseRefund(transactionId);

  return {
    transaction_id: transactionId,
    status: 'refunded',
    ...(gatewayRefundRef && { gateway_refund_reference: gatewayRefundRef }),
  };
}

/**
 * Get transaction history for a client.
 */
async function getClientTransactions(clientId, organizationId) {
  const [rows] = await db.query(
    'SELECT * FROM payment_transactions WHERE client_id = ? AND organization_id = ? ORDER BY created_at DESC',
    [clientId, organizationId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Webhook Signature Verification
// ---------------------------------------------------------------------------

/**
 * Verify a Stripe webhook signature (Stripe-Signature header).
 *
 * Stripe signs payloads using HMAC-SHA256 with a tolerance window.
 * The header contains: t=<timestamp>,v1=<signature>
 *
 * @param {string} rawBody   - The raw request body string
 * @param {string} sigHeader - Value of the Stripe-Signature header
 * @param {string} secret    - The webhook signing secret (whsec_…)
 * @param {number} [tolerance=300] - Maximum age of the event in seconds
 * @returns {boolean} True if the signature is valid
 */
function verifyStripeSignature(rawBody, sigHeader, secret, tolerance = 300) {
  if (!sigHeader || !secret) return false;

  const parts = {};
  for (const item of sigHeader.split(',')) {
    const [key, value] = item.split('=');
    if (key && value) {
      if (!parts[key]) parts[key] = [];
      parts[key].push(value);
    }
  }

  const timestamp = parts.t?.[0];
  const signatures = parts.v1 || [];
  if (!timestamp || signatures.length === 0) return false;

  // Tolerance check: reject events older than `tolerance` seconds or
  // more than 5 seconds in the future (clock-skew allowance).
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (isNaN(age) || age > tolerance || age < -5) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  try {
    return signatures.some(sig =>
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')),
    );
  } catch (_err) {
    return false;
  }
}

/**
 * Parse a Conekta webhook-key public key (the `public_key` PEM returned by
 * POST https://api.conekta.io/webhook_keys). Accepts a real PEM or the JSON-
 * escaped form with literal "\n" sequences (as copied from the API response).
 * Returns a crypto KeyObject, or null when the value is not an RSA public key
 * (for example an old shared-secret string): the caller treats null as "not
 * configured" and fails closed.
 *
 * @param {string|null|undefined} value
 * @returns {crypto.KeyObject|null}
 */
function parseConektaPublicKey(value) {
  if (!value || typeof value !== 'string') return null;
  const pem = value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
  if (!/-----BEGIN (RSA )?PUBLIC KEY-----/.test(pem)) return null;
  try {
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === 'rsa' ? key : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Verify a Conekta webhook signature (DIGEST header).
 *
 * Conekta signs the SHA-256 of the raw UTF-8 request body with the private
 * half of the company's webhook key (RSA, PKCS#1 v1.5) and sends the
 * signature base64-encoded in the `DIGEST` header ("Verificar firmas",
 * developers.conekta.com). Only the webhook key's PUBLIC key can verify it;
 * there is no shared secret.
 *
 * @param {string} rawBody       - The raw request body string
 * @param {string} digestHeader  - Value of the DIGEST header (base64)
 * @param {string|crypto.KeyObject} publicKey - PEM or parsed public key
 * @returns {boolean} True if the signature is valid
 */
function verifyConektaSignature(rawBody, digestHeader, publicKey) {
  if (!digestHeader || !publicKey || typeof rawBody !== 'string') return false;
  const key = typeof publicKey === 'string' ? parseConektaPublicKey(publicKey) : publicKey;
  if (!key) return false;

  const encoded = String(digestHeader).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const signature = Buffer.from(encoded, 'base64');
  if (signature.length === 0) return false;

  try {
    return crypto.verify('RSA-SHA256', Buffer.from(rawBody, 'utf8'), key, signature);
  } catch (_err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Webhook Event Processing
// ---------------------------------------------------------------------------

/**
 * Process an inbound webhook event from a payment provider.
 *
 * Handles deduplication, status mapping, and calls reconcilePayment when
 * a payment is confirmed.
 *
 * @param {object} params
 * @param {string} params.provider       - 'stripe' or 'conekta'
 * @param {string} params.providerEventId - Unique event ID from the provider
 * @param {string} params.eventType      - Provider event type string
 * @param {object} params.payload        - Full event payload (parsed JSON)
 * @param {number} [params.organizationId] - When the webhook arrived on a
 *        gateway-scoped route, restrict transaction matching to that tenant so
 *        one org's webhook can never reconcile another org's transaction.
 * @returns {object} { status, webhookEventId }
 */
async function handleWebhookEvent({ provider, providerEventId, eventType, payload, organizationId }) {
  // Deduplication, scoped per-tenant (migration 417) via the org_dedup partition
  // (= organization_id, or 0 for the global env-var route). A gateway-scoped
  // event carries its owning org; two orgs sharing one provider account dedup
  // independently. The dedup key is STABLE for the row's life — organization_id
  // is NOT re-homed after matching a transaction (that would move a global row
  // out of partition 0 and let provider REDELIVERIES re-process it).
  const orgKey = organizationId ?? null;
  const orgDedup = organizationId ?? 0;
  const [existing] = await db.query(
    'SELECT id, status FROM webhook_events WHERE provider = ? AND provider_event_id = ? AND org_dedup = ?',
    [provider, providerEventId, orgDedup],
  );

  let webhookEventId;
  if (existing.length > 0) {
    // A redelivery of an event whose processing FAILED (the receiver answered
    // 500, e.g. reconciliation threw) is processed again — that redelivery is
    // the provider's retry. Claim it atomically so two concurrent redeliveries
    // cannot both run. Anything else (processed/ignored/processing) is a true
    // duplicate.
    if (existing[0].status !== 'failed') {
      return { status: 'duplicate', webhookEventId: existing[0].id };
    }
    const [claim] = await db.query(
      "UPDATE webhook_events SET status = 'processing', error_message = NULL WHERE id = ? AND status = 'failed'",
      [existing[0].id],
    );
    if (!claim || claim.affectedRows !== 1) {
      return { status: 'duplicate', webhookEventId: existing[0].id };
    }
    webhookEventId = existing[0].id;
  } else {
    // Insert the event record — organization_id set at insert for gateway events
    // (NULL for the global route → org_dedup 0). org_dedup is a generated column.
    const [insertResult] = await db.query(
      `INSERT INTO webhook_events (organization_id, provider, provider_event_id, event_type, payload, status)
       VALUES (?, ?, ?, ?, ?, 'processing')`,
      [orgKey, provider, providerEventId, eventType, JSON.stringify(payload)],
    );
    webhookEventId = insertResult.insertId;
  }

  try {
    // Autopay card capture (Stripe Checkout in setup mode) has no payment
    // transaction to reconcile — store the saved card as a recurring profile.
    if (provider === 'stripe' && eventType === 'checkout.session.completed' && payload.data?.object?.mode === 'setup') {
      try {
        const autopayService = require('./autopayService');
        const setupObj = payload.data.object;
        // Pass the session's OWN metadata (organization_id + gateway_id, set at
        // enrollment) so completeEnrollment can resolve the exact gateway. The
        // global env-var route arrives with organizationId=undefined — without
        // the metadata the enrollment would be silently dropped.
        await autopayService.completeEnrollment({
          sessionId: setupObj.id,
          organizationId,
          metadata: setupObj.metadata || {},
        });
      } catch (enrollErr) {
        logger.error({ enrollErr }, 'Autopay enrollment from setup session failed');
      }
      await db.query(
        'UPDATE webhook_events SET status = \'processed\', processed_at = NOW() WHERE id = ?',
        [webhookEventId],
      );
      return { status: 'processed', webhookEventId, autopay: true };
    }

    // Extract the gateway reference ID and new status from the event
    const { gatewayRef, newStatus, dispute = null } = mapProviderEvent(provider, eventType, payload);

    if (!gatewayRef || !newStatus) {
      // Event type we don't handle — mark as ignored
      await db.query(
        'UPDATE webhook_events SET status = \'ignored\', processed_at = NOW() WHERE id = ?',
        [webhookEventId],
      );
      return { status: 'ignored', webhookEventId };
    }

    // Find the matching payment transaction. When the event arrived on a
    // gateway-scoped route, confine the match to that tenant (cross-tenant
    // reconciliation guard); otherwise fall back to the global lookup.
    let [txRows] = organizationId
      ? await db.query(
        'SELECT * FROM payment_transactions WHERE gateway_reference_id = ? AND organization_id = ? LIMIT 1',
        [gatewayRef, organizationId],
      )
      : await db.query(
        'SELECT * FROM payment_transactions WHERE gateway_reference_id = ? LIMIT 1',
        [gatewayRef],
      );

    // Fallback: a Checkout Session carries transaction_id in its metadata, so if
    // the reference lookup misses (e.g. the gateway_reference_id UPDATE never
    // landed after the session was created) we can still recover the tx by id.
    // Only within a known organization: transaction ids are per database, and
    // an id-only lookup on the install-wide route could settle another
    // tenant's transaction that happens to share the number (WHK-11).
    if (txRows.length === 0 && organizationId) {
      const metaTxId = payload?.data?.object?.metadata?.transaction_id;
      if (metaTxId) {
        [txRows] = await db.query('SELECT * FROM payment_transactions WHERE id = ? AND organization_id = ? LIMIT 1', [metaTxId, organizationId]);
      }
    }

    if (txRows.length === 0) {
      await db.query(
        'UPDATE webhook_events SET status = \'failed\', error_message = \'No matching transaction found\', processed_at = NOW() WHERE id = ?',
        [webhookEventId],
      );
      return { status: 'no_match', webhookEventId };
    }

    const tx = txRows[0];

    // Providers do not guarantee delivery order. A late payment_failed (an
    // earlier declined attempt inside the same Checkout Session) must never
    // demote a captured payment, and nothing may resurrect a refunded one.
    if (!isAllowedGatewayTransition(tx.gateway_status, newStatus)) {
      await db.query(
        'UPDATE webhook_events SET transaction_id = ?, status = \'ignored\', error_message = ?, processed_at = NOW() WHERE id = ?',
        [tx.id, `Stale event: transaction is ${tx.gateway_status}, not moving to ${newStatus}`, webhookEventId],
      );
      return { status: 'ignored', webhookEventId, transactionId: tx.id, reason: 'stale_transition' };
    }

    // Update the transaction status. A completed Stripe Checkout Session also
    // names its PaymentIntent: store that pi_ id as the gateway reference, so
    // charge.refunded / charge.dispute.created (keyed by payment_intent) match
    // and refundStripe() refunds a real PaymentIntent instead of a cs_ id.
    // Later checkout.session.* events still match via metadata.transaction_id.
    const piRef = provider === 'stripe' && eventType.startsWith('checkout.session.')
      && typeof payload?.data?.object?.payment_intent === 'string'
      && payload.data.object.payment_intent.startsWith('pi_')
      ? payload.data.object.payment_intent
      : null;
    await db.query(
      'UPDATE payment_transactions SET gateway_status = ?, webhook_payload = ?, gateway_reference_id = COALESCE(?, gateway_reference_id) WHERE id = ?',
      [newStatus, JSON.stringify(payload), piRef, tx.id],
    );

    // Update the webhook event with the transaction link. NOTE: organization_id
    // is deliberately NOT re-homed here — it (and the derived org_dedup) is fixed
    // at insert so the dedup key is stable for the row's life. For a global-route
    // event that stays NULL/partition-0; the owning org is derivable via
    // transaction_id → payment_transactions.organization_id.
    await db.query(
      'UPDATE webhook_events SET transaction_id = ?, status = \'processed\', processed_at = NOW() WHERE id = ?',
      [tx.id, webhookEventId],
    );

    // Auto-reconciliation for successful payments. reconcilePayment throws when
    // it cannot post the payment; the catch below then marks this event failed
    // and the route answers 500, so the provider redelivers it (a failed event
    // is re-processed above). The reconcile_gateway_payments task also sweeps
    // any succeeded transaction still without a payment.
    let reconciliation = null;
    if (newStatus === 'succeeded') {
      reconciliation = await reconcilePayment(tx.id);

      // Cancel any pending retries for this transaction
      try {
        const paymentRetryService = require('./paymentRetryService');
        await paymentRetryService.cancelRetries({ transactionId: tx.id });
      } catch (cancelErr) {
        logger.error({ cancelErr, transactionId: tx.id }, 'Failed to cancel payment retries after webhook success');
      }
    }

    // A refund fired at the provider (dashboard/API or a charge.refunded event) —
    // reverse the settled invoice + ledger so the balance reflects the reversal.
    if (newStatus === 'refunded') {
      await reverseRefund(tx.id);
    }

    // Auto-create a chargeback record when a dispute is received — §2.5.3 —
    // and record its outcome when it closes.
    if (newStatus === 'disputed' || dispute) {
      try {
        // payment_transactions.currency is NOT NULL so the fallback should
        // never fire — but when it does, use the org's currency, never 'USD'.
        const cbCurrency = tx.currency
          || await require('../models/Organization').getCurrency(tx.organization_id);
        await db.query(
          `INSERT INTO chargebacks
             (organization_id, payment_id, gateway, gateway_dispute_id, amount, currency, reason_code, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             status = IF(VALUES(status) = 'received', status, VALUES(status)),
             updated_at = NOW()`,
          [
            tx.organization_id,
            // chargebacks.payment_id is a payments.id. A disputed charge that was
            // never reconciled into a payment has none.
            tx.payment_id || null,
            provider,
            // The provider's dispute id, so created and closed land on one row;
            // the charge reference when the event carries none (Conekta).
            dispute?.id || gatewayRef,
            tx.amount,
            cbCurrency,
            dispute?.reason || eventType,
            dispute?.outcome || 'received',
          ],
        );
        logger.info({ transactionId: tx.id, provider, gatewayRef }, 'Chargeback auto-created from webhook');
      } catch (chargebackErr) {
        logger.error({ chargebackErr, transactionId: tx.id }, 'Failed to auto-create chargeback from webhook');
      }
    }

    logger.info({ provider, eventType, transactionId: tx.id }, 'Webhook event processed');

    return {
      status: 'processed', webhookEventId, transactionId: tx.id, newStatus,
      ...(reconciliation && { reconciliation: reconciliation.status, paymentId: reconciliation.paymentId ?? null }),
    };
  } catch (err) {
    await db.query(
      'UPDATE webhook_events SET status = \'failed\', error_message = ?, processed_at = NOW() WHERE id = ?',
      [err.message, webhookEventId],
    );
    throw err;
  }
}

/**
 * Map a provider-specific event type to a gateway reference ID and a
 * normalized transaction status.
 */
function mapProviderEvent(provider, eventType, payload) {
  if (provider === 'stripe') {
    const obj = payload.data?.object || {};

    // Hosted Checkout Session events — the reference is the session id (cs_...)
    // stored on the pending transaction at createCheckoutSession time.
    if (eventType === 'checkout.session.completed') {
      // Card/synchronous methods settle immediately (payment_status 'paid');
      // async methods (bank debits) settle later via async_payment_succeeded, so
      // don't mark those succeeded yet.
      return { gatewayRef: obj.id || null, newStatus: obj.payment_status === 'paid' ? 'succeeded' : null };
    }
    if (eventType === 'checkout.session.async_payment_succeeded') {
      return { gatewayRef: obj.id || null, newStatus: 'succeeded' };
    }
    if (eventType === 'checkout.session.async_payment_failed' || eventType === 'checkout.session.expired') {
      return { gatewayRef: obj.id || null, newStatus: 'failed' };
    }

    // charge.refunded fires for PARTIAL refunds too; only a FULL refund re-opens
    // the invoice. A partial refund is left for manual handling (never reverses
    // the whole invoice + a full-amount debit).
    if (eventType === 'charge.refunded') {
      const fully = obj.refunded === true
        || (typeof obj.amount_refunded === 'number' && typeof obj.amount === 'number' && obj.amount_refunded >= obj.amount);
      return { gatewayRef: obj.payment_intent || obj.id, newStatus: fully ? 'refunded' : null };
    }

    // A dispute event's object is the dispute (du_…); its charge's
    // PaymentIntent is what the transaction holds. A dispute the merchant
    // loses returns the money to the cardholder for good, so the settlement is
    // reversed like a refund; a won one leaves the transaction disputed and
    // only records the outcome on the chargeback.
    if (eventType === 'charge.dispute.created' || eventType === 'charge.dispute.closed') {
      const outcome = eventType === 'charge.dispute.created' ? 'received'
        : ({ lost: 'lost', won: 'won' }[obj.status] || null);
      if (!outcome) return { gatewayRef: null, newStatus: null };
      return {
        gatewayRef: obj.payment_intent || obj.charge || null,
        newStatus: outcome === 'lost' ? 'refunded' : 'disputed',
        dispute: { id: obj.id || null, outcome, reason: obj.reason || null },
      };
    }

    const gatewayRef = obj.id || null;
    const statusMap = {
      'payment_intent.succeeded': 'succeeded',
      'payment_intent.payment_failed': 'failed',
    };

    // For charge events, the gateway reference may be the payment_intent
    const ref = eventType.startsWith('charge.')
      ? (obj.payment_intent || obj.id)
      : gatewayRef;

    return { gatewayRef: ref, newStatus: statusMap[eventType] || null };
  }

  if (provider === 'conekta') {
    const obj = payload.data?.object || {};
    // order.* events carry the order (ord_…), which is what checkout/charge
    // store as the reference; charge.* events carry a charge whose order_id
    // names that order.
    const gatewayRef = (eventType.startsWith('charge.') && obj.order_id) || obj.id || null;

    const statusMap = {
      'order.paid': 'succeeded',
      'order.payment_failed': 'failed',
      'charge.refunded': 'refunded',
      'charge.chargeback.created': 'disputed',
    };

    return { gatewayRef, newStatus: statusMap[eventType] || null };
  }

  return { gatewayRef: null, newStatus: null };
}

// ---------------------------------------------------------------------------
// Auto-reconciliation
// ---------------------------------------------------------------------------

// Gateway transaction status moves a webhook may make. Providers redeliver and
// reorder events, so a captured payment only moves on to refunded/disputed and a
// refund is terminal; anything still pending/failed/cancelled may move freely
// (a declined first attempt followed by a successful retry is normal).
const GATEWAY_TRANSITIONS = {
  succeeded: ['succeeded', 'refunded', 'disputed'],
  disputed: ['disputed', 'refunded'],
  refunded: ['refunded'],
};

function isAllowedGatewayTransition(from, to) {
  const allowed = GATEWAY_TRANSITIONS[from];
  return !allowed || allowed.includes(to);
}

function parseJsonColumn(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_err) { return null; }
}

/**
 * Map a captured gateway transaction to a payments.payment_method value (ENUM
 * in database/schema.sql). The method drives the SAT forma de pago stamped on
 * the REP, so prefer what the provider actually reports in the success payload:
 * Conekta's charge payment_method (card credit/debit, OXXO cash, SPEI) and a
 * Stripe session/intent restricted to OXXO. Everything else captured by a card
 * processor is a card payment.
 */
function resolveGatewayPaymentMethod(provider, webhookPayload) {
  const obj = parseJsonColumn(webhookPayload)?.data?.object || {};
  if (provider === 'conekta') {
    const pm = obj.charges?.data?.[0]?.payment_method || obj.payment_method || {};
    const kind = `${pm.type || ''} ${pm.object || ''}`.toLowerCase();
    if (/\bdebit\b/.test(kind)) return 'debit_card';
    if (/\bcredit\b/.test(kind)) return 'credit_card';
    if (/oxxo|cash/.test(kind)) return 'oxxo_pay';
    if (/spei|bank_transfer/.test(kind)) return 'spei';
    return 'card';
  }
  if (provider === 'stripe') {
    const types = Array.isArray(obj.payment_method_types) ? obj.payment_method_types : [];
    if (types.length === 1 && types[0] === 'oxxo') return 'oxxo_pay';
    return 'card';
  }
  if (provider === 'manual') return 'other';
  return 'online';
}

/**
 * Turn a SUCCEEDED gateway transaction into a payment, exactly once.
 *
 * In one transaction, holding the payment_transactions row FOR UPDATE:
 *   1. insert a 'completed' payments row (method + sat_forma_pago mapped from
 *      the provider, reference_number = gateway reference) and link it through
 *      payment_transactions.payment_id;
 *   2. write the payment's client_balance_ledger credit (the same
 *      billingService.recordPaymentCredit a staff-recorded payment writes);
 *   3. allocate it with paymentAllocationService.allocateAcrossInvoices, the
 *      allocate-auto waterfall: to the transaction's own invoice when it has
 *      one (checkout / payment link / autopay), otherwise FIFO over the
 *      client's payable invoices. A fully covered invoice is marked paid with
 *      paid_at; anything left over stays on the payment as client credit.
 * After commit, best-effort like the staff routes: reconnect a suspended
 * contract of each invoice that became paid, cancel pending charge retries for
 * it, and generate the REP (Complemento de Pago) for each allocation.
 *
 * Idempotent: a transaction that already has payment_id (a replayed webhook,
 * both checkout.session.completed and payment_intent.succeeded, the sweep) is a
 * no-op, as is one reconciled by the pre-migration-472 code (it carries a
 * 'payment_transaction' ledger credit and was settled without a payment row).
 *
 * Throws when posting fails, after rolling back, so the caller can retry: the
 * webhook answers 500 (the provider redelivers) and the sweep counts a failure.
 *
 * @param {number} transactionId
 * @returns {Promise<{status: string, paymentId?: number, allocations?: object[], remainingCredit?: number}>}
 */
async function reconcilePayment(transactionId) {
  // Lazy requires: these services pull in large dependency graphs, and
  // paymentRetryService requires this module.
  const paymentAllocationService = require('./paymentAllocationService');
  const billingService = require('./billingService');

  const conn = await db.getConnection();
  let posted;
  try {
    await conn.beginTransaction();
    const exec = conn.execute.bind(conn);

    const [txRows] = await exec('SELECT * FROM payment_transactions WHERE id = ? FOR UPDATE', [transactionId]);
    const tx = txRows[0];
    if (!tx) {
      await conn.rollback();
      return { status: 'not_found' };
    }
    if (tx.payment_id) {
      await conn.rollback();
      return { status: 'already_reconciled', paymentId: tx.payment_id };
    }
    if (tx.gateway_status !== 'succeeded') {
      await conn.rollback();
      return { status: 'not_succeeded' };
    }
    // Lock the invoices this capture may settle before any non-locking read
    // (DAL-04), so their balance_due includes allocations committed while
    // this transaction waited.
    await paymentAllocationService.lockInvoicesForAllocation(exec, tx.organization_id,
      tx.invoice_id ? { invoiceIds: [tx.invoice_id] } : { clientIds: [tx.client_id] });
    const [legacy] = await exec(
      `SELECT id FROM client_balance_ledger
        WHERE reference_type = 'payment_transaction' AND reference_id = ? AND entry_type = 'credit' LIMIT 1`,
      [tx.id],
    );
    if (legacy.length > 0) {
      await conn.rollback();
      return { status: 'legacy_reconciled' };
    }

    const orgId = tx.organization_id;
    const [gwRows] = await exec(
      'SELECT provider FROM payment_gateways WHERE id = ? AND organization_id = ? LIMIT 1',
      [tx.payment_gateway_id, orgId],
    );
    const provider = gwRows[0]?.provider || null;
    const paymentMethod = resolveGatewayPaymentMethod(provider, tx.webhook_payload);
    const { FORMA_PAGO_BY_METHOD } = require('./repService');

    // Target invoices, locked: the linked invoice only (still payable, same
    // org + client), or every payable invoice of the client, oldest first.
    const invoices = await paymentAllocationService.getInvoicesWithBalance(
      exec, orgId, tx.client_id, tx.invoice_id ? [tx.invoice_id] : null, true,
    );
    const linkedInvoice = tx.invoice_id ? (invoices[0] || null) : null;

    const reference = String(tx.gateway_reference_id || `transaction ${tx.id}`).slice(0, 100);
    const [payResult] = await exec(
      `INSERT INTO payments
         (organization_id, client_id, invoice_id, amount, currency, payment_method,
          sat_forma_pago, reference_number, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')`,
      [orgId, tx.client_id, linkedInvoice ? linkedInvoice.id : null, tx.amount, tx.currency,
        paymentMethod, FORMA_PAGO_BY_METHOD[paymentMethod] || null, reference,
        `Online payment via ${provider || 'payment gateway'} (gateway transaction #${tx.id})`],
    );
    const paymentId = payResult.insertId;

    await exec('UPDATE payment_transactions SET payment_id = ? WHERE id = ?', [paymentId, tx.id]);

    await billingService.recordPaymentCredit(
      { id: paymentId, client_id: tx.client_id, amount: tx.amount, currency: tx.currency, reference_number: reference },
      orgId, exec,
    );

    const { allocations, justPaidInvoices, remainder } = await paymentAllocationService.allocateAcrossInvoices(
      exec, { paymentId, amount: tx.amount, invoices },
    );

    // settled_invoice_id records the invoice this capture turned paid (kept for
    // the legacy refund path and reporting); NULL when it settled none.
    if (justPaidInvoices.length > 0) {
      await exec('UPDATE payment_transactions SET settled_invoice_id = ? WHERE id = ?', [justPaidInvoices[0].id, tx.id]);
    }

    await conn.commit();
    posted = { tx, orgId, paymentId, allocations, justPaidInvoices, remainder };
  } catch (err) {
    try { await conn.rollback(); } catch (_rollbackErr) { /* keep the original error */ }
    logger.error({ err, transactionId }, 'Gateway payment reconciliation failed');
    throw err;
  } finally {
    conn.release();
  }

  const { tx, orgId, paymentId, allocations, justPaidInvoices, remainder } = posted;
  logger.info({ transactionId, paymentId, allocated: allocations.length, remainder }, 'Gateway payment reconciled');

  // Post-commit side effects, best-effort: the money is already posted.
  for (const invoice of justPaidInvoices) {
    try {
      await paymentAllocationService.reconnectIfSuspended(invoice, null, orgId);
    } catch (err) {
      logger.error({ err, transactionId, invoiceId: invoice.id }, 'Reconnect after gateway payment failed');
    }
    try {
      await require('./paymentRetryService').cancelRetries({ invoiceId: invoice.id });
    } catch (err) {
      logger.error({ err, transactionId, invoiceId: invoice.id }, 'Cancelling charge retries after gateway payment failed');
    }
  }
  const repService = require('./repService');
  for (const a of allocations) {
    await repService.maybeGenerateRep(paymentId, a.invoice_id, a.amount, orgId, null);
  }

  return {
    status: 'reconciled', paymentId, transactionId: tx.id,
    allocations, remainingCredit: remainder,
  };
}

/**
 * Re-derive an invoice's paid status from its live allocations on the open
 * transaction (same rule as billingService.refreshInvoicePaidStatus).
 */
async function refreshInvoicePaidStatusOn(exec, invoiceId) {
  const [rows] = await exec(
    `SELECT i.total,
            COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                       WHERE pa.invoice_id = i.id AND pa.deleted_at IS NULL), 0)
              + ${creditAppliedSql('i')} AS allocated
       FROM invoices i WHERE i.id = ?`,
    [invoiceId],
  );
  const inv = rows[0];
  if (!inv) return;
  if (parseFloat(inv.allocated) >= parseFloat(inv.total)) {
    await exec("UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = ? AND status <> 'paid'", [invoiceId]);
  } else {
    await exec("UPDATE invoices SET status = 'issued', paid_at = NULL WHERE id = ? AND status = 'paid'", [invoiceId]);
  }
}

/**
 * Reverse the bookkeeping of a REFUNDED gateway payment.
 *
 * Reconciled through a payment (payment_id set): mark that payment refunded,
 * soft-delete its allocations, re-open each invoice they had paid, and append
 * an offsetting ledger debit. The computed balance counts only completed
 * payments, so the refunded money stops counting either as a settlement or as
 * client credit.
 *
 * Legacy (reconciled before migration 472, a 'payment_transaction' ledger
 * credit and no payment): re-open settled_invoice_id and append the debit.
 *
 * Idempotent: a payment already 'refunded', or a legacy transaction that
 * already has its reversal debit, is left alone, so refund() + charge.refunded
 * (or a redelivery) never double-reverse. Best-effort — logs, never throws.
 */
async function reverseRefund(transactionId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const exec = conn.execute.bind(conn);
    const [txRows] = await exec('SELECT * FROM payment_transactions WHERE id = ? FOR UPDATE', [transactionId]);
    const tx = txRows[0];
    if (!tx) { await conn.rollback(); return; }

    if (tx.payment_id) {
      const [payRows] = await exec(
        'SELECT * FROM payments WHERE id = ? AND organization_id <=> ? FOR UPDATE',
        [tx.payment_id, tx.organization_id],
      );
      const payment = payRows[0];
      if (!payment || payment.status === 'refunded') { await conn.commit(); return; }

      await exec("UPDATE payments SET status = 'refunded' WHERE id = ?", [payment.id]);
      const [allocs] = await exec(
        'SELECT DISTINCT invoice_id FROM payment_allocations WHERE payment_id = ? AND deleted_at IS NULL',
        [payment.id],
      );
      if (allocs.length > 0) {
        await exec('UPDATE payment_allocations SET deleted_at = NOW() WHERE payment_id = ? AND deleted_at IS NULL', [payment.id]);
        for (const { invoice_id: invoiceId } of allocs) {
          await refreshInvoicePaidStatusOn(exec, invoiceId);
        }
      }
      // A soft-deleted payment already had its ledger credit removed by the
      // payments DELETE hook; only offset a credit that still stands.
      if (!payment.deleted_at) {
        await exec(
          `INSERT INTO client_balance_ledger
             (client_id, organization_id, entry_type, amount, currency, reference_type, reference_id, description)
           VALUES (?, ?, 'debit', ?, ?, 'payment', ?, ?)`,
          [payment.client_id, payment.organization_id, payment.amount, payment.currency, payment.id,
            `Refund of gateway payment ${payment.reference_number || payment.id}`],
        );
      }
      await conn.commit();
      logger.info({ transactionId, paymentId: payment.id }, 'Refund reversed the gateway payment and its allocations');
      return;
    }

    // Legacy path: only reverse a payment we actually reconciled (a credit
    // ledger entry exists)...
    const [credits] = await exec(
      `SELECT id FROM client_balance_ledger
        WHERE reference_type = 'payment_transaction' AND reference_id = ? AND entry_type = 'credit' LIMIT 1`,
      [tx.id],
    );
    // ...and only once (no prior reversal debit for this tx).
    const [debits] = await exec(
      `SELECT id FROM client_balance_ledger
        WHERE reference_type = 'payment_transaction' AND reference_id = ? AND entry_type = 'debit' LIMIT 1`,
      [tx.id],
    );
    if (credits.length === 0 || debits.length > 0) { await conn.commit(); return; }

    // Re-open ONLY the invoice this payment actually settled. When
    // settled_invoice_id is NULL the payment settled nothing (a standing
    // credit), so there is nothing to re-open — we still write the debit.
    if (tx.settled_invoice_id) {
      await exec(
        "UPDATE invoices SET status = 'issued' WHERE id = ? AND status = 'paid'",
        [tx.settled_invoice_id],
      );
    }
    await exec(
      `INSERT INTO client_balance_ledger
         (client_id, organization_id, entry_type, amount, currency, reference_type, reference_id, description)
       VALUES (?, ?, 'debit', ?, ?, 'payment_transaction', ?, ?)`,
      [tx.client_id, tx.organization_id, tx.amount, tx.currency, tx.id,
        `Refund reversal of gateway payment ${tx.gateway_reference_id}`],
    );
    await conn.commit();
    logger.info({ transactionId, invoiceId: tx.settled_invoice_id ?? null }, 'Refund reversed the settled invoice + ledger');
  } catch (err) {
    await conn.rollback();
    logger.error({ err, transactionId }, 'Refund reversal failed');
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Reconciliation retry sweep (scheduled task reconcile_gateway_payments)
// ---------------------------------------------------------------------------

const RECONCILE_SWEEP_LIMIT = 200;

/**
 * Reconcile the succeeded transactions of one organization that still have no
 * payment (a reconcile that failed, or a webhook that never arrived after a
 * synchronous capture). Runs in the caller's database context.
 */
async function reconcileOutstandingForOrganization(orgId, limit = RECONCILE_SWEEP_LIMIT) {
  const safeLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || RECONCILE_SWEEP_LIMIT));
  const [rows] = await db.query(
    `SELECT pt.id FROM payment_transactions pt
      WHERE pt.organization_id = ? AND pt.gateway_status = 'succeeded' AND pt.payment_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM client_balance_ledger l
                         WHERE l.reference_type = 'payment_transaction' AND l.reference_id = pt.id
                           AND l.entry_type = 'credit')
      ORDER BY pt.id ASC
      LIMIT ${safeLimit}`,
    [orgId],
  );
  const summary = { candidates: rows.length, reconciled: 0, skipped: 0, failed: 0, failures: [] };
  for (const { id } of rows) {
    try {
      const result = await reconcilePayment(id);
      if (result.status === 'reconciled') summary.reconciled += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.failed += 1;
      summary.failures.push({ transaction_id: id, error: err.message });
    }
  }
  return summary;
}

/**
 * Retry path for gateway reconciliation. With an organization id, sweep that
 * organization in its database context. Without one (the seeded install-wide
 * task), fan out over every active organization: shared-database orgs on the
 * primary, isolated tenants inside their own database context, one org's
 * failure never stopping the rest (same shape as taskRunner's alert fan-out).
 */
async function reconcileOutstandingTransactions(organizationId = null, { limit } = {}) {
  const withPrimary = (callback) => (
    typeof db.withPrimaryContext === 'function' ? db.withPrimaryContext(callback) : callback()
  );
  const withTenant = (orgId, callback) => (
    typeof db.withTenantContext === 'function' ? db.withTenantContext(orgId, callback) : callback()
  );

  if (organizationId !== null && organizationId !== undefined) {
    const orgId = Number(organizationId);
    return withTenant(orgId, () => reconcileOutstandingForOrganization(orgId, limit));
  }

  const [organizations] = await withPrimary(() => db.query(
    `SELECT o.id,
            CASE WHEN odc.isolation_mode = 'isolated' THEN 'isolated' ELSE 'shared' END AS database_scope
       FROM organizations o
       LEFT JOIN organization_database_configs odc ON odc.organization_id = o.id
      WHERE o.status = 'active' AND o.deleted_at IS NULL
      ORDER BY o.id`,
  ));

  const summary = {
    organizations_total: organizations.length, organizations_failed: 0,
    candidates: 0, reconciled: 0, skipped: 0, failed: 0, failures: [],
  };
  for (const organization of organizations) {
    const orgId = Number(organization.id);
    try {
      const run = () => reconcileOutstandingForOrganization(orgId, limit);
      const result = organization.database_scope === 'isolated'
        ? await withTenant(orgId, run)
        : await withPrimary(run);
      summary.candidates += result.candidates;
      summary.reconciled += result.reconciled;
      summary.skipped += result.skipped;
      summary.failed += result.failed;
      summary.failures.push(...result.failures.map((f) => ({ organization_id: orgId, ...f })));
    } catch (err) {
      summary.organizations_failed += 1;
      summary.failures.push({ organization_id: orgId, error: err.message });
      logger.warn({ err, organizationId: orgId }, 'Gateway reconciliation sweep failed for organization; continuing');
    }
  }
  if (summary.organizations_total > 0 && summary.organizations_failed === summary.organizations_total) {
    const err = new Error('Gateway reconciliation sweep failed for every active organization');
    err.failures = summary.failures;
    throw err;
  }
  return summary;
}

module.exports = {
  getActiveGateway,
  getGatewayById,
  loadGatewayWebhookContext,
  charge,
  refund,
  getClientTransactions,
  chargeStripe,
  createStripeCheckoutSession,
  createConektaCheckoutSession,
  createStripeCustomer,
  createStripeSetupSession,
  retrieveStripeCheckoutSession,
  chargeConekta,
  checkIdempotencyKey,
  storeIdempotencyKey,
  verifyStripeSignature,
  parseConektaPublicKey,
  verifyConektaSignature,
  handleWebhookEvent,
  isAllowedGatewayTransition,
  resolveGatewayPaymentMethod,
  reconcilePayment,
  reverseRefund,
  reconcileOutstandingTransactions,
  paymentCircuitBreaker,
};
