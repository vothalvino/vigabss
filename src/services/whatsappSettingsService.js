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

// The last reply Meta refused, kept so the settings screen can say that
// replies are failing (an expired access token is otherwise only visible in
// the server log). One install-wide `settings` row, cleared by the next reply
// that goes out and when the token or number is replaced.
const SEND_FAILURE_KEY = 'whatsapp_last_send_failure';
// Meta error codes that mean the token or its permissions are the problem.
const AUTH_ERROR_CODES = new Set(['190', '10', '200', '401', '403', '131005']);
const FAILURE_WRITE_INTERVAL_MS = 60 * 1000;
let sendFailure = null;   // { message, code, since, last, count } | null
let lastFailureWrite = 0;

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
  const keys = [...FIELD_NAMES.map(f => FIELDS[f].key), SEND_FAILURE_KEY].map(k => `'${k}'`).join(', '); // code constants
  const [rows] = await db.withPrimaryContext(() => db.query(
    `SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${keys})`,
  ));
  const out = {};
  let failure = null;
  for (const row of rows || []) {
    if (row.setting_key === SEND_FAILURE_KEY) {
      try { failure = row.setting_value ? JSON.parse(row.setting_value) : null; } catch { failure = null; }
      continue;
    }
    const field = FIELD_NAMES.find(f => FIELDS[f].key === row.setting_key);
    const raw = row.setting_value;
    if (!field || raw === null || raw === undefined || raw === '') continue;
    const value = FIELDS[field].secret ? decrypt(raw) : raw;
    if (value) out[field] = String(value);
  }
  sendFailure = failure && typeof failure === 'object' && failure.message ? failure : null;
  return out;
}

async function writeSendFailure(value) {
  await db.withPrimaryContext(() => db.query(
    `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [SEND_FAILURE_KEY, value ? JSON.stringify(value) : ''],
  ));
}

/**
 * Meta refused a reply. Remembered for the settings screen; a run of failures
 * is one record (first time, last time, how many), written at most once a
 * minute. Never throws: this must not turn a failed send into a crash.
 */
async function noteSendFailure({ message, code = null } = {}) {
  try {
    const now = new Date().toISOString();
    const first = !sendFailure;
    sendFailure = {
      message: String(message || 'unknown error').slice(0, 300),
      code: code === null || code === undefined ? null : String(code),
      since: sendFailure?.since || now,
      last: now,
      count: Number(sendFailure?.count || 0) + 1,
    };
    if (first || Date.now() - lastFailureWrite >= FAILURE_WRITE_INTERVAL_MS) {
      lastFailureWrite = Date.now();
      await writeSendFailure(sendFailure);
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'whatsappSettings: could not record the send failure');
  }
}

/** A reply went out: whatever was failing is over. Never throws. */
async function noteSendSuccess() {
  if (!sendFailure) return;
  try {
    sendFailure = null;
    lastFailureWrite = 0;
    await writeSendFailure(null);
  } catch (err) {
    logger.warn({ err: err.message }, 'whatsappSettings: could not clear the send failure');
  }
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
  };
  // Receiving needs the secret (signature) and the verify token (handshake);
  // replying needs the number ID and the access token.
  // The last reply Meta refused, if replies are failing right now. `auth`
  // says the token or its permissions were rejected (the usual cause: a
  // temporary token that expired).
  view.send_failure = sendFailure ? {
    message: sendFailure.message,
    auth: AUTH_ERROR_CODES.has(String(sendFailure.code)) || /authenticat|access token|session has expired/i.test(sendFailure.message),
    since: sendFailure.since,
    last: sendFailure.last,
    count: sendFailure.count,
  } : null;
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
  // A new token or number makes the recorded failure stale: the next reply
  // says whether it works.
  if (sendFailure && ('access_token' in updates || 'phone_number_id' in updates)) {
    await noteSendSuccess();
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
  initialize, stop, refresh, getView, save, testConnection, noteSendFailure, noteSendSuccess,
  FIELDS, FIELD_NAMES, REFRESH_MS,
};
