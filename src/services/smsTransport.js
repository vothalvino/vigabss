// =============================================================================
// VigaBSS 5.0 — SMS Transport Service
// =============================================================================
// Sends SMS (and WhatsApp) messages via a configurable provider.
// Supported providers:
//   twilio   — Twilio REST API (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)
//   generic  — Any provider that accepts an HTTP POST with JSON or form body
//              (SMS_PROVIDER_URL / SMS_PROVIDER_API_KEY / SMS_PROVIDER_FROM)
//
// sendSms() delivers one message now and logs the attempt to sms_logs; it is
// the message outbox's SMS/WhatsApp adapter. Producers call queueSms(), which
// writes to the outbox (src/services/messageOutbox.js, ASY-33).
// =============================================================================

const https = require('https');
const http  = require('http');
const { URLSearchParams } = require('url');
const { URL } = require('url');
const db = require('../config/database');
const logger = require('../utils/logger');
const communicationPreferences = require('./clientCommunicationPreferenceService');


// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect the active provider from environment variables.
 * @returns {'twilio'|'generic'|null}
 */
function detectProvider() {
  if (process.env.SMS_PROVIDER === 'generic' && process.env.SMS_PROVIDER_URL) return 'generic';
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) return 'twilio';
  if (process.env.SMS_PROVIDER_URL) return 'generic';
  return null;
}

/**
 * Send via Twilio REST API (no SDK — built-in https module).
 * @param {object} opts
 * @param {string} opts.to       - E.164 destination number
 * @param {string} opts.body     - Message text
 * @param {'sms'|'whatsapp'} [opts.channel='sms']
 * @returns {Promise<{sid: string, status: string}>}
 */
function sendViaTwilio({ to, body, channel = 'sms' }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;

  const fromNumber = channel === 'whatsapp'
    ? `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_FROM}`
    : (process.env.TWILIO_FROM || '');

  const toNumber = channel === 'whatsapp' ? `whatsapp:${to}` : to;

  const postBody = new URLSearchParams({
    To:   toNumber,
    From: fromNumber,
    Body: body,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.twilio.com',
      path:     `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method:   'POST',
      headers:  {
        Authorization:   `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const err = new Error(parsed.message || `Twilio HTTP ${res.statusCode}`);
            err.code = String(parsed.code || res.statusCode);
            err.httpStatus = res.statusCode;
            reject(err);
          } else {
            resolve({ sid: parsed.sid, status: parsed.status });
          }
        } catch (_parseErr) {
          const err = new Error(`Twilio response parse error: ${data.slice(0, 200)}`);
          // A non-JSON error page still proves the provider refused the call.
          if (res.statusCode >= 400) err.httpStatus = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Twilio request timed out')));
    req.on('error', reject);
    req.write(postBody);
    req.end();
  });
}

/**
 * Send via a generic HTTP provider (e.g. Infobip, MessageBird, local MX gateway).
 * POST JSON to SMS_PROVIDER_URL with { to, from, body } and optional Bearer auth.
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.body
 * @param {'sms'|'whatsapp'} [opts.channel='sms']
 * @returns {Promise<{sid: string|null, status: string}>}
 */
function sendViaGeneric({ to, body, channel = 'sms' }) {
  const rawUrl  = process.env.SMS_PROVIDER_URL;
  const apiKey  = process.env.SMS_PROVIDER_API_KEY || '';
  const from    = process.env.SMS_PROVIDER_FROM || process.env.SMS_FROM || '';

  const parsed  = new URL(rawUrl);
  const isHttps = parsed.protocol === 'https:';
  const lib     = isHttps ? https : http;
  const port    = parsed.port || (isHttps ? 443 : 80);

  const payload = JSON.stringify({ to, from, body, channel });

  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const req = lib.request({
      hostname: parsed.hostname,
      port,
      path:    parsed.pathname + (parsed.search || ''),
      method:  'POST',
      headers,
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const result = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            const err = new Error(result.message || result.error || `Provider HTTP ${res.statusCode}`);
            err.code  = String(result.code || res.statusCode);
            err.httpStatus = res.statusCode;
            reject(err);
          } else {
            resolve({ sid: result.id || result.messageId || null, status: result.status || 'sent' });
          }
        } catch (_parseErr) {
          // Non-JSON 2xx response — treat as success
          if (res.statusCode < 400) resolve({ sid: null, status: 'sent' });
          else reject(Object.assign(new Error(`Provider HTTP ${res.statusCode}: ${data.slice(0, 200)}`), { httpStatus: res.statusCode }));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('SMS provider request timed out')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Dispatch a message through the configured provider.
 * @returns {Promise<{sid: string|null, status: string}>}
 */
function dispatchViaProvider({ to, body, channel }) {
  const provider = detectProvider();
  if (provider === 'twilio')  return sendViaTwilio({ to, body, channel });
  if (provider === 'generic') return sendViaGeneric({ to, body, channel });
  throw Object.assign(
    new Error('No SMS provider configured. Set TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN or SMS_PROVIDER_URL.'),
    { code: 'SMS_PROVIDER_NOT_CONFIGURED' },
  );
}

// Failures that prove the provider never accepted the message: it answered
// with an error status, the connection was never made, or there is no
// provider. Anything else (a timeout, a reset mid-request) may have sent it.
const UNSENT_CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'SMS_PROVIDER_NOT_CONFIGURED']);
function provablyUnsent(err) {
  return Boolean(err?.httpStatus) || UNSENT_CONNECTION_CODES.has(err?.code);
}

// Provider vocabularies are broader than sms_logs.status (Twilio may return
// accepted/scheduled/sending and generic gateways may return arbitrary text).
// A successful HTTP/provider call means the platform accepted the message;
// only an explicit delivered result advances the stronger local state.
function normalizeAcceptedStatus(status) {
  return status === 'delivered' ? 'delivered' : 'sent';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send an SMS (or WhatsApp) message immediately and log the result to sms_logs.
 *
 * @param {object} opts
 * @param {number} opts.organizationId
 * @param {number|null} [opts.clientId]
 * @param {string} opts.to              - E.164 phone number, e.g. +521234567890
 * @param {string} opts.body            - Message body text
 * @param {'sms'|'whatsapp'} [opts.channel='sms']
 * @param {number|null} [opts.templateId]
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendSmsCurrent({
  organizationId,
  clientId = null,
  to,
  body,
  channel = 'sms',
  templateId = null,
  messageClass = null,
  expectedClientContactEpoch = null,
}) {
  const provider = detectProvider() || 'none';
  const organizationState = await communicationPreferences.getOrganizationDeliveryState(organizationId);

  let status;
  let providerMessageId = null;
  let errorCode         = null;
  let errorMessage      = null;
  let sentAt            = null;
  let clientContactEpoch = 0;
  let unsent            = false;
  let permanent         = false;

  try {
    if (!organizationState.active) {
      throw Object.assign(new Error('Organization is inactive.'), { code: 'ORGANIZATION_INACTIVE' });
    }
    if (clientId !== null && clientId !== undefined) {
      const preference = await communicationPreferences.evaluateClientCommunication({
        organizationId,
        clientId,
        channel,
        destination: to,
        messageClass,
      });
      if (!preference.allowed) {
        status = 'failed';
        errorCode = preference.code;
        errorMessage = 'Client communication preference blocks this delivery.';
      } else {
        clientContactEpoch = Number(preference.contactEpoch || 0);
        if (expectedClientContactEpoch !== null
            && Number(expectedClientContactEpoch) !== clientContactEpoch) {
          status = 'failed';
          errorCode = communicationPreferences.BLOCK_CODES.CONTACT_MISMATCH;
          errorMessage = 'Client contact authorization changed; message skipped.';
        }
      }
    }

    const finalOrganizationState = await communicationPreferences.getOrganizationDeliveryState(organizationId);
    if (status !== 'failed' && (!finalOrganizationState.active
        || Number(finalOrganizationState.epoch) !== Number(organizationState.epoch))) {
      throw Object.assign(new Error('Organization delivery state changed.'), {
        code: 'ORGANIZATION_INACTIVE',
      });
    }
    if (status !== 'failed' && clientId !== null && clientId !== undefined) {
      const finalPreference = await communicationPreferences.evaluateClientCommunication({
        organizationId,
        clientId,
        channel,
        destination: to,
        messageClass,
      });
      const finalEpoch = Number(finalPreference.contactEpoch || 0);
      if (!finalPreference.allowed || finalEpoch !== clientContactEpoch
          || (expectedClientContactEpoch !== null
            && Number(expectedClientContactEpoch) !== finalEpoch)) {
        status = 'failed';
        errorCode = finalPreference.allowed
          ? communicationPreferences.BLOCK_CODES.CONTACT_MISMATCH
          : finalPreference.code;
        errorMessage = 'Client communication preference blocks this delivery.';
      }
    }
    const result = status === 'failed' ? null : await dispatchViaProvider({ to, body, channel });
    if (!result) throw Object.assign(new Error(errorMessage), { code: errorCode, preferenceBlocked: true });
    // Twilio queues first then delivers — treat 'queued' and 'sent' as success
    status            = normalizeAcceptedStatus(result.status);
    providerMessageId = result.sid || null;
    sentAt            = new Date();
  } catch (err) {
    status       = 'failed';
    errorCode    = err.code   || null;
    errorMessage = err.message || String(err);
    unsent       = Boolean(err.preferenceBlocked) || provablyUnsent(err);
    // A 4xx (other than rate limiting) is the provider refusing this message
    // for good, e.g. an invalid number; retrying cannot help.
    permanent    = err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 429;
    if (!err.preferenceBlocked) logger.warn({ err, to, channel }, 'SMS send failed');
  }

  await db.query(
    `INSERT INTO sms_logs
       (organization_id, organization_epoch, client_id, client_contact_epoch, phone_number, channel, direction, template_id,
        message_body, provider, provider_message_id, status, error_code, error_message,
        message_class, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      organizationId, organizationState.epoch || 0, clientId, clientContactEpoch, to, channel, templateId,
      body, provider, providerMessageId,
      status, errorCode, errorMessage,
      messageClass,
      sentAt,
    ],
  );

  if (status === 'sent' || status === 'delivered') {
    return { success: true, messageId: providerMessageId };
  }
  const preferenceSkipped = Object.values(communicationPreferences.BLOCK_CODES).includes(errorCode);
  return {
    success: false,
    error: errorMessage,
    ...(errorCode && { code: errorCode }),
    ...(preferenceSkipped && { skipped: true }),
    ...(unsent && { unsent: true }),
    ...(permanent && { permanent: true }),
  };
}

function withOrganization(organizationId, callback) {
  return organizationId === null || organizationId === undefined
    || typeof db.withTenantContext !== 'function'
    ? callback()
    : db.withTenantContext(Number(organizationId), callback);
}

function assertClientSmsAttribution(options) {
  const organizationId = Number(options?.organizationId);
  const clientId = Number(options?.clientId);
  if (!Number.isSafeInteger(organizationId) || organizationId <= 0
      || !Number.isSafeInteger(clientId) || clientId <= 0
      || !options?.messageClass) {
    throw Object.assign(new Error('SMS/WhatsApp client attribution and messageClass are required.'), {
      code: 'CLIENT_ATTRIBUTION_REQUIRED',
    });
  }
  communicationPreferences.assertMessageClass(options.messageClass);
}

async function sendSms(options) {
  assertClientSmsAttribution(options);
  return withOrganization(options?.organizationId, () => sendSmsCurrent(options || {}));
}

/**
 * Queue an SMS or WhatsApp message in the message outbox (ASY-33), which
 * checks consent now and again before the provider call, and retries only
 * failures that provably sent nothing.
 * @returns {Promise<{queued: boolean, id: number|null, skipped?: true, code?: string, duplicate?: true}>}
 */
async function queueSms(options) {
  assertClientSmsAttribution(options);
  const {
    organizationId, clientId, to, body, channel = 'sms', templateId = null, messageClass,
    dedupeKey = null, sourceType = null, sourceId = null,
  } = options;
  return require('./messageOutbox').enqueue({
    channel, organizationId, clientId, messageClass, recipient: to, bodyText: body,
    payload: templateId ? { template_id: templateId } : null, dedupeKey, sourceType, sourceId,
  });
}

module.exports = {
  sendSms,
  queueSms,
  assertClientSmsAttribution,
  detectProvider,
};
