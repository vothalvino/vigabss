// =============================================================================
// VigaBSS 5.0 — WhatsApp (Meta Cloud API) connection settings
// =============================================================================
// The WhatsApp connection used to be configurable only in the server's
// environment file. This stores the same values in the install-wide `settings`
// table so the install operator can manage them from the app, and lays them
// over config.whatsapp, which every WhatsApp code path already reads at call
// time (the webhook's signature check, the verification handshake, outbound
// replies).
//
// - Install-wide, like the WhatsApp tables themselves: an inbound message is
//   resolved by phone number before any organization is known.
// - A value saved here wins; a field left empty falls back to its environment
//   variable, so an install configured by environment keeps working untouched.
// - The three secrets are encrypted at rest and never returned: the API
//   reports only whether each one is set and where it comes from.
// - Other processes and replicas pick up a change within REFRESH_MS.
// =============================================================================

const https = require('https');
const config = require('../config');
const db = require('../config/database');
const { encrypt, decrypt } = require('../utils/encryption');
const logger = require('../utils/logger').child({ service: 'whatsappSettings' });
const { installPaymentMode } = require('../utils/paymentMode');

const REFRESH_MS = 60 * 1000;

// field -> { key in `settings`, property of config.whatsapp, secret? }
const FIELDS = {
  phone_number_id: { key: 'whatsapp_phone_number_id', prop: 'phoneNumberId', secret: false },
  business_number: { key: 'whatsapp_business_number', prop: 'businessNumber', secret: false },
  access_token: { key: 'whatsapp_access_token', prop: 'accessToken', secret: true },
  app_secret: { key: 'whatsapp_app_secret', prop: 'appSecret', secret: true },
  verify_token: { key: 'whatsapp_verify_token', prop: 'verifyToken', secret: true },
};
const FIELD_NAMES = Object.keys(FIELDS);

// What the environment supplied, captured before anything is laid over it.
const ENV_BASE = Object.fromEntries(FIELD_NAMES.map(f => [f, config.whatsapp?.[FIELDS[f].prop] || '']));

let stored = {};          // field -> plaintext value saved in `settings`
let refreshTimer = null;

function validationProblem(field, value) {
  if (typeof value !== 'string') return 'must be a string';
  if (value.length > 600) return 'is too long';
  if (/[\r\n]/.test(value)) return 'must be a single line';
  if (field === 'phone_number_id' && !/^\d{5,25}$/.test(value)) return 'must be the numeric phone number ID from Meta';
  if (field === 'business_number' && !/^\+?\d{8,15}$/.test(value)) return 'must be a phone number with country code, digits only';
  if (FIELDS[field].secret && value.length < 8) return 'is too short';
  return null;
}

async function readStored() {
  const keys = FIELD_NAMES.map(f => `'${FIELDS[f].key}'`).join(', '); // code constants
  const [rows] = await db.withPrimaryContext(() => db.query(
    `SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${keys})`,
  ));
  const out = {};
  for (const row of rows || []) {
    const field = FIELD_NAMES.find(f => FIELDS[f].key === row.setting_key);
    const raw = row.setting_value;
    if (!field || raw === null || raw === undefined || raw === '') continue;
    const value = FIELDS[field].secret ? decrypt(raw) : raw;
    if (value) out[field] = String(value);
  }
  return out;
}

/** Lay the stored values over config.whatsapp; empty fields fall back to the environment. */
function apply(values) {
  stored = values;
  for (const field of FIELD_NAMES) {
    config.whatsapp[FIELDS[field].prop] = values[field] || ENV_BASE[field] || '';
  }
}

async function refresh() {
  apply(await readStored());
}

/** Load the settings at start and keep them fresh. Never throws: the environment values stay in force. */
async function initialize() {
  try {
    await refresh();
  } catch (err) {
    logger.warn({ err: err.message }, 'whatsappSettings: could not load stored settings; using the environment');
  }
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      refresh().catch(err => logger.warn({ err: err.message }, 'whatsappSettings: refresh failed'));
    }, REFRESH_MS);
    refreshTimer.unref();
  }
}

function stop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function sourceOf(field) {
  if (stored[field]) return 'settings';
  return ENV_BASE[field] ? 'environment' : null;
}

/** What the settings screen shows. No secret leaves the server. */
function getView() {
  const effective = f => config.whatsapp[FIELDS[f].prop] || '';
  const webhookUrl = `${String(config.appUrl || '').replace(/\/+$/, '')}/api/v1/whatsapp/webhook`;
  const view = {
    phone_number_id: effective('phone_number_id'),
    business_number: effective('business_number'),
    has_access_token: Boolean(effective('access_token')),
    has_app_secret: Boolean(effective('app_secret')),
    has_verify_token: Boolean(effective('verify_token')),
    sources: Object.fromEntries(FIELD_NAMES.map(f => [f, sourceOf(f)])),
    webhook_url: webhookUrl,
    graph_version: config.whatsapp.graphVersion,
    // The install's test/live setting (PAYMENT_MODE), for the screen's badge.
    install_mode: installPaymentMode(),
  };
  // Receiving needs the secret (signature) and the verify token (handshake);
  // replying needs the number ID and the access token.
  view.can_receive = view.has_app_secret && view.has_verify_token;
  view.can_send = Boolean(view.phone_number_id) && view.has_access_token;
  return view;
}

/**
 * Save a partial update. Per field: omitted = unchanged, '' or null = remove
 * the stored value (the environment value, if any, applies again), a string =
 * replace.
 *
 * @returns {Promise<{ changed: string[] }>} the fields that were written
 */
async function save(input = {}) {
  const updates = {};
  for (const field of FIELD_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const value = input[field];
    if (value === null || value === '') { updates[field] = ''; continue; }
    const trimmed = typeof value === 'string' ? value.trim() : value;
    const problem = validationProblem(field, trimmed);
    if (problem) {
      const err = new Error(`${field} ${problem}`);
      err.statusCode = 422;
      err.code = 'INVALID_WHATSAPP_SETTING';
      throw err;
    }
    updates[field] = trimmed;
  }

  for (const [field, value] of Object.entries(updates)) {
    const toStore = value && FIELDS[field].secret ? encrypt(value) : value;
    await db.withPrimaryContext(() => db.query(
      `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [FIELDS[field].key, toStore],
    ));
  }
  await refresh();
  return { changed: Object.keys(updates) };
}

function graphGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.facebook.com', path, method: 'GET', timeout: 10000,
      headers: { Authorization: `Bearer ${accessToken}` },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Meta did not answer in time')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Ask Meta about the configured number with the configured token. Proves the
 * number ID and access token; it cannot prove the app secret or the webhook,
 * which only an inbound message does.
 */
const META_TEST_NUMBER_NAME = 'Test Number';

async function testConnection({ get = graphGet } = {}) {
  const { phoneNumberId, accessToken, graphVersion } = config.whatsapp;
  if (!phoneNumberId || !accessToken) {
    return { ok: false, error: 'The phone number ID and the access token are both needed.' };
  }
  try {
    const { status, body } = await get(
      `/${graphVersion}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`,
      accessToken,
    );
    if (status === 200 && body && !body.error) {
      return {
        ok: true,
        display_phone_number: body.display_phone_number || null,
        verified_name: body.verified_name || null,
        // Meta names its sandbox number "Test Number"; it only reaches the
        // recipients approved in the Meta app.
        test_number: body.verified_name === META_TEST_NUMBER_NAME,
      };
    }
    // Meta's own message says what is wrong (expired token, wrong ID, missing
    // permission) and contains no secret.
    const reason = body?.error?.message || `Meta answered HTTP ${status}`;
    return { ok: false, error: String(reason).slice(0, 300) };
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 300) };
  }
}

module.exports = {
  initialize, stop, refresh, getView, save, testConnection,
  FIELDS, FIELD_NAMES, REFRESH_MS,
};
