// =============================================================================
// VigaBSS 5.0 — WhatsApp identity service
// =============================================================================
// The trust layer beneath the WhatsApp bot: normalize phone numbers, mint and
// verify short-lived linking/step-up codes (hashed, single-use, rate-limited),
// bind a phone number to a client, and resolve an inbound number back to a
// bound client. See docs/whatsapp-support-design.md.
//
// Security posture:
//   - Only sha256(code + server pepper) is ever stored — never the plaintext
//     code (mirrors clients.portal_reset_token_hash). The pepper makes a stolen
//     whatsapp_verifications row useless for offline brute force of the short
//     numeric codes.
//   - Code comparison is constant-time.
//   - At most ONE active binding per phone number install-wide (the inbound
//     webhook has no org context, so a sender must resolve to exactly one
//     client). Enforced by the whatsapp_links.active_phone UNIQUE and a
//     revoke-then-insert transaction here.
//   - Phone- and code-keyed lookups (verifyPhoneCode, verifyPortalCode,
//     bindNumber, resolveBinding, conversation state by phone) are install-wide
//     by design: the inbound webhook has no org context. Every CLIENT-keyed
//     query, however, also binds the client's organization null-safely
//     (`organization_id <=> ?`) — a client_id match alone is not a tenant
//     boundary (ARCHITECTURE.md). Callers pass the portal client's org, or for
//     webhook callers the org of the already-resolved link/client row, never a
//     payload value.
// =============================================================================

const crypto = require('crypto');
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');

// The WhatsApp tables (links, verifications, inbound log, conversation state)
// are install-wide and live on the primary database: an inbound message is
// resolved by phone before any organization is known. Every query here is
// pinned there, so a caller inside an isolated tenant's context (the bound
// bot, the clients routes revoking links) reads and writes the real rows
// rather than the tenant database's empty copies (SUP-12). Client rows are
// read in their organization's database where needed.
function primaryQuery(sql, params) {
  return typeof db.withPrimaryContext === 'function'
    ? db.withPrimaryContext(() => db.query(sql, params))
    : db.query(sql, params);
}
const { requireOrgId } = require('../utils/requireOrgId');

const PORTAL_CODE_LENGTH = 8; // phone-agnostic lookup — larger space
const EMAIL_CODE_LENGTH  = 6; // delivered to a second channel (email)

// ---------------------------------------------------------------------------
// Phone normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw phone / WhatsApp sender id to E.164 (`+<digits>`).
 *
 * Handles the Mexican mobile quirk: WhatsApp historically prefixes MX mobiles
 * with a `1` after the country code (521XXXXXXXXXX, 13 digits). Canonical E.164
 * for MX is 52 + 10 digits, so we drop that legacy `1` — this makes the two
 * forms WhatsApp may deliver for the same physical number converge to one key.
 *
 * @param {string} raw            e.g. "whatsapp:+5215512345678", "55 1234 5678"
 * @param {string} [defaultCountry='MX']
 * @returns {string|null} E.164 string, or null if unparseable
 */
function normalizeE164(raw, defaultCountry = config.whatsapp.defaultCountry) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/^whatsapp:/i, '').trim();
  const hadPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;

  // Strip an international access prefix (00 34... -> 34...).
  if (digits.startsWith('00')) digits = digits.slice(2);

  if ((defaultCountry || '').toUpperCase() === 'MX') {
    // Bare 10-digit national number with no country code -> assume MX (+52).
    if (!hadPlus && digits.length === 10) digits = `52${digits}`;
    // Legacy MX mobile 521 + 10 digits -> drop the 1.
    if (digits.startsWith('521') && digits.length === 13) digits = `52${digits.slice(3)}`;
  }

  return `+${digits}`;
}

/**
 * Normalize a sender id delivered by a WhatsApp provider. Meta's wa_id and
 * Twilio's `whatsapp:+…` always carry the country code, so a 10-digit id is
 * NOT a bare Mexican number: +45 Denmark, +47 Norway, +65 Singapore and +354
 * Iceland have 10-digit international forms, and treating them as MX
 * collided them with real MX bindings and misaddressed replies (SUP-03).
 *
 * @param {string} raw  e.g. "4521234567" (Meta) or "whatsapp:+5215512345678"
 * @returns {string|null}
 */
function normalizeSenderId(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/^whatsapp:/i, '').trim();
  return normalizeE164(s.startsWith('+') ? s : `+${s}`);
}

// ---------------------------------------------------------------------------
// Code generation / hashing
// ---------------------------------------------------------------------------

/** Cryptographically-random numeric code of the given length (no modulo bias). */
function generateNumericCode(length) {
  const code = crypto.randomInt(0, 10 ** length);
  return String(code).padStart(length, '0');
}

/** sha256(code + server pepper) hex. */
function hashCode(code) {
  return crypto.createHash('sha256')
    .update(String(code) + config.whatsapp.otpPepper)
    .digest('hex');
}

/** Constant-time hex-digest comparison. */
function hexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// ---------------------------------------------------------------------------
// Verifications (linking / step-up codes)
// ---------------------------------------------------------------------------

/**
 * Has this phone requested too many email-linking codes recently?
 * Guards the email-OTP path against mail-bombing / enumeration timing.
 */
async function emailCodeBudgetExceeded(phone) {
  const [rows] = await primaryQuery(
    `SELECT COUNT(*) AS n FROM whatsapp_verifications
      WHERE phone_e164 = ? AND purpose = 'link_email'
        AND created_at > (NOW() - INTERVAL 1 HOUR)`,
    [phone],
  );
  return (rows[0]?.n || 0) >= config.whatsapp.maxCodesPerHour;
}

/**
 * Mint a verification code and persist only its hash.
 * @returns {Promise<string>} the plaintext code (caller delivers it out-of-band)
 */
async function createVerification({ organizationId = null, phone = null, purpose, clientId = null, channel, length, ttlMinutes = config.whatsapp.linkCodeTtlMinutes }) {
  const code = generateNumericCode(length);
  await primaryQuery(
    `INSERT INTO whatsapp_verifications
       (organization_id, phone_e164, purpose, client_id, code_hash, channel, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, (NOW() + INTERVAL ? MINUTE))`,
    [organizationId, phone, purpose, clientId, hashCode(code), channel, ttlMinutes],
  );
  return code;
}

/**
 * Mint a portal linking code for an authenticated portal client. Phone is
 * unknown at mint time (the client may message from any number), so the code is
 * verified later by value, not by phone.
 */
function createPortalLinkCode({ organizationId, clientId }) {
  return createVerification({
    organizationId,
    clientId,
    phone: null,
    purpose: 'link_portal',
    channel: 'portal',
    length: PORTAL_CODE_LENGTH,
  });
}

// Wrong email-OTP guesses allowed against ONE client in a rolling day, across
// every phone and every code (SUP-10). The per-code ceiling alone let an
// attacker cycling numbers keep guessing at one account indefinitely.
const CLIENT_LINK_GUESSES_PER_DAY = 20;

/** True once a client's email-linking codes absorbed the day's wrong guesses. */
async function clientLinkGuessesExhausted(clientId) {
  const [rows] = await primaryQuery(
    `SELECT COALESCE(SUM(attempts), 0) - COALESCE(SUM(consumed_at IS NOT NULL), 0) AS failed
       FROM whatsapp_verifications
      WHERE client_id = ? AND purpose = 'link_email' AND created_at > (NOW() - INTERVAL 1 DAY)`,
    [clientId],
  );
  const failed = Number(rows[0]?.failed || 0);
  if (failed >= CLIENT_LINK_GUESSES_PER_DAY) {
    logger.warn({ clientId, failed }, 'WhatsApp email linking locked for the day: too many wrong codes');
    return true;
  }
  return false;
}

/**
 * Verify a code tied to a specific phone + purpose (email-OTP, step-up).
 * Increments attempts on mismatch and refuses once the attempt ceiling is hit.
 * @returns {Promise<{ok:boolean, reason?:string, clientId?:number, organizationId?:number}>}
 */
async function verifyPhoneCode({ phone, purpose, code }) {
  const [rows] = await primaryQuery(
    `SELECT id, client_id, organization_id, code_hash, attempts
       FROM whatsapp_verifications
      WHERE phone_e164 = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1`,
    [phone, purpose],
  );
  const v = rows[0];
  if (!v) return { ok: false, reason: 'no_pending' };
  if (v.client_id && await clientLinkGuessesExhausted(v.client_id)) return { ok: false, reason: 'locked' };

  // Claim an attempt BEFORE comparing (SUP-10). Reading attempts and
  // incrementing afterwards let concurrently processed guesses all pass the
  // ceiling; this conditional UPDATE lets exactly maxCodeAttempts through.
  const [claim] = await primaryQuery(
    `UPDATE whatsapp_verifications SET attempts = attempts + 1
      WHERE id = ? AND attempts < ? AND consumed_at IS NULL`,
    [v.id, config.whatsapp.maxCodeAttempts],
  );
  if (!claim || claim.affectedRows !== 1) return { ok: false, reason: 'locked' };

  if (!hexEqual(hashCode(code), v.code_hash)) return { ok: false, reason: 'mismatch' };
  const [consumed] = await primaryQuery(
    'UPDATE whatsapp_verifications SET consumed_at = NOW() WHERE id = ? AND consumed_at IS NULL',
    [v.id],
  );
  if (!consumed || consumed.affectedRows !== 1) return { ok: false, reason: 'no_pending' };
  return { ok: true, clientId: v.client_id, organizationId: v.organization_id };
}

/**
 * Verify a portal linking code by value (phone-agnostic). The code hash carries
 * the server pepper, and codes are short-lived + single-use; the bot layer adds
 * a per-phone attempt throttle on top of this.
 *
 * If two clients happen to mint the SAME code within the window (a collision —
 * no attacker required), we refuse to bind rather than guess a client, which
 * would otherwise cross-tenant mis-bind. Both codes just become unusable until
 * one expires (self-healing); no wrong binding is ever created.
 * @returns {Promise<{ok:boolean, reason?:string, clientId?:number, organizationId?:number}>}
 */
async function verifyPortalCode({ code }) {
  const [rows] = await primaryQuery(
    `SELECT id, client_id, organization_id
       FROM whatsapp_verifications
      WHERE purpose = 'link_portal' AND code_hash = ? AND consumed_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 2`,
    [hashCode(code)],
  );
  if (rows.length === 0) return { ok: false, reason: 'no_match' };
  if (rows.length > 1) return { ok: false, reason: 'ambiguous' };
  const v = rows[0];
  await primaryQuery('UPDATE whatsapp_verifications SET consumed_at = NOW() WHERE id = ?', [v.id]);
  return { ok: true, clientId: v.client_id, organizationId: v.organization_id };
}

/** Count a client's still-pending portal linking codes minted in the last hour. */
async function pendingPortalCodeCount(clientId, organizationId) {
  requireOrgId(organizationId, 'whatsappService.pendingPortalCodeCount');
  const [rows] = await primaryQuery(
    `SELECT COUNT(*) AS n FROM whatsapp_verifications
      WHERE client_id = ? AND organization_id <=> ? AND purpose = 'link_portal' AND consumed_at IS NULL
        AND created_at > (NOW() - INTERVAL 1 HOUR)`,
    [clientId, organizationId],
  );
  return rows[0]?.n || 0;
}

/** Has this client been sent too many email linking codes recently (target-inbox budget)? */
async function clientEmailCodeBudgetExceeded(clientId, organizationId) {
  requireOrgId(organizationId, 'whatsappService.clientEmailCodeBudgetExceeded');
  const [rows] = await primaryQuery(
    `SELECT COUNT(*) AS n FROM whatsapp_verifications
      WHERE client_id = ? AND organization_id <=> ? AND purpose = 'link_email'
        AND created_at > (NOW() - INTERVAL 1 HOUR)`,
    [clientId, organizationId],
  );
  return (rows[0]?.n || 0) >= config.whatsapp.maxCodesPerHour;
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/**
 * Bind a phone number to a client. Revokes any existing active binding for the
 * same phone (install-wide) first, transactionally, so re-linking a number to a
 * new client works and the active_phone UNIQUE never blocks a legitimate rebind.
 * @returns {Promise<{id:number}>}
 */
async function bindNumber({ organizationId = null, clientId, phone, via }) {
  const conn = await (typeof db.withPrimaryContext === 'function' ? db.withPrimaryContext(() => db.getConnection()) : db.getConnection());
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE whatsapp_links SET status = 'revoked', revoked_at = NOW()
        WHERE active_phone = ?`,
      [phone],
    );
    const [ins] = await conn.execute(
      `INSERT INTO whatsapp_links
         (organization_id, client_id, phone_e164, bound_via, status, bound_at)
       VALUES (?, ?, ?, ?, 'active', NOW())`,
      [organizationId, clientId, phone, via],
    );
    // A rebind must not carry the previous occupant's in-flight bot flow.
    await conn.execute('DELETE FROM whatsapp_conversation_state WHERE phone_e164 = ?', [phone]);
    await conn.commit();
    await notifyOwnerOfBinding({ organizationId, clientId, phone });
    return { id: ins.insertId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Tell the account owner by email that a number was bound, so a binding made
 * by someone else (a recycled or stolen number, a guessed code) is noticed
 * (SUP-04). Best-effort.
 */
async function notifyOwnerOfBinding({ organizationId, clientId, phone }) {
  try {
    const readClient = () => db.query('SELECT name, email FROM clients WHERE id = ? AND deleted_at IS NULL', [clientId]);
    const [[client]] = await (organizationId && typeof db.withTenantContext === 'function'
      ? db.withTenantContext(organizationId, readClient)
      : readClient());
    if (!client?.email) return;
    const last4 = String(phone).slice(-4);
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
    await require('./emailTransport').sendEmail({
      organizationId,
      clientId,
      messageClass: 'security',
      to: client.email,
      subject: 'Se vinculó un número de WhatsApp a tu cuenta',
      html: `<p>Hola ${esc(client.name)},</p>`
        + `<p>El número de WhatsApp terminado en <strong>${esc(last4)}</strong> quedó vinculado a tu cuenta.</p>`
        + '<p>Si no fuiste tú, contacta a soporte de inmediato para desvincularlo.</p>',
    });
  } catch (err) {
    logger.warn({ err, clientId }, 'whatsapp: binding notice email failed');
  }
}

/** Days without a message after which a binding must be verified again (0 = never). */
function linkIdleDays() {
  const n = Number(config.whatsapp.linkIdleDays ?? 180);
  return Number.isFinite(n) && n >= 0 ? n : 180;
}

/**
 * Resolve an inbound phone number to its active binding (install-wide).
 *
 * A binding answers for its client only while the client is live (not
 * archived, not inactive) and the number has been used within
 * WHATSAPP_LINK_IDLE_DAYS: a recycled or lost number otherwise kept reading
 * the account (SUP-04). A binding that fails either test is revoked, so the
 * number has to be linked again.
 * @returns {Promise<{clientId:number, organizationId:number|null, linkId:number}|null>}
 */
async function resolveBinding(phone) {
  const [rows] = await primaryQuery(
    `SELECT id, client_id, organization_id, bound_at, last_seen_at FROM whatsapp_links
      WHERE active_phone = ? LIMIT 1`,
    [phone],
  );
  const l = rows[0];
  if (!l) return null;

  const idleDays = linkIdleDays();
  const lastUse = new Date(l.last_seen_at || l.bound_at);
  const idle = idleDays > 0 && Number.isFinite(lastUse.getTime())
    && Date.now() - lastUse.getTime() > idleDays * 86400000;

  // The client row lives in its organization's database.
  const readClient = () => db.query('SELECT status, deleted_at FROM clients WHERE id = ? LIMIT 1', [l.client_id]);
  const [[client]] = await (l.organization_id && typeof db.withTenantContext === 'function'
    ? db.withTenantContext(l.organization_id, readClient)
    : readClient());
  const live = client && !client.deleted_at && client.status !== 'inactive';

  if (idle || !live) {
    await primaryQuery(
      "UPDATE whatsapp_links SET status = 'revoked', revoked_at = NOW() WHERE id = ? AND status = 'active'",
      [l.id],
    );
    logger.info({ linkId: l.id, clientId: l.client_id, reason: idle ? 'idle' : 'client_not_live' }, 'whatsapp: binding revoked on use');
    return null;
  }
  return { clientId: l.client_id, organizationId: l.organization_id, linkId: l.id };
}

/** Mark the bound number as seen (best-effort; failure is non-fatal). */
async function touchBinding(linkId) {
  try {
    await primaryQuery('UPDATE whatsapp_links SET last_seen_at = NOW() WHERE id = ?', [linkId]);
  } catch (err) {
    logger.warn({ err, linkId }, 'whatsapp: touchBinding failed');
  }
}

/**
 * List a client's active bindings (for the portal "Connect WhatsApp" screen).
 * Numbers are masked by the caller before display.
 */
async function listClientLinks(clientId, organizationId) {
  requireOrgId(organizationId, 'whatsappService.listClientLinks');
  const [rows] = await primaryQuery(
    `SELECT id, phone_e164, bound_via, bound_at, last_seen_at
       FROM whatsapp_links
      WHERE client_id = ? AND organization_id <=> ? AND status = 'active'
      ORDER BY bound_at DESC`,
    [clientId, organizationId],
  );
  return rows;
}

/**
 * Revoke every active binding of a client: its contact details changed, its
 * portal password was reset, or it was archived or made inactive (SUP-04).
 * @param {Function} [exec] query function (a caller's transaction)
 * @returns {Promise<number>} bindings revoked
 */
async function revokeClientLinks({ clientId, organizationId, reason }, exec = primaryQuery) {
  requireOrgId(organizationId, 'whatsappService.revokeClientLinks');
  const [res] = await exec(
    `UPDATE whatsapp_links SET status = 'revoked', revoked_at = NOW()
      WHERE client_id = ? AND organization_id <=> ? AND status = 'active'`,
    [clientId, organizationId],
  );
  const revoked = Number(res?.affectedRows || 0);
  if (revoked > 0) {
    await exec('DELETE FROM whatsapp_conversation_state WHERE client_id = ?', [clientId]).catch(() => {});
    logger.info({ clientId, organizationId, reason, revoked }, 'whatsapp: client bindings revoked');
  }
  return revoked;
}

/** Revoke a client's binding by id (client-initiated unlink). Scoped to the client and its org. */
async function revokeLink({ clientId, organizationId, linkId }) {
  requireOrgId(organizationId, 'whatsappService.revokeLink');
  const [res] = await primaryQuery(
    `UPDATE whatsapp_links SET status = 'revoked', revoked_at = NOW()
      WHERE id = ? AND client_id = ? AND organization_id <=> ? AND status = 'active'`,
    [linkId, clientId, organizationId],
  );
  if (res.affectedRows > 0) {
    // Drop any in-flight bot flow for this client (portal/bot unlink path).
    // whatsapp_conversation_state has no organization_id, so it is scoped
    // through its parent client row.
    await primaryQuery(
      `DELETE s FROM whatsapp_conversation_state s
         JOIN clients c ON c.id = s.client_id AND c.organization_id <=> ?
        WHERE s.client_id = ?`,
      [organizationId, clientId],
    ).catch(() => {});
  }
  return res.affectedRows > 0;
}

// ---------------------------------------------------------------------------
// Inbound message log / dedup
// ---------------------------------------------------------------------------

/**
 * Redact digit runs (linking codes, OTPs, phone/account numbers) before an
 * inbound message body is persisted — the raw text can contain the code the
 * user just typed, and codes must never land in the DB in plaintext.
 */
function redactSecrets(text) {
  if (!text) return text;
  return String(text).replace(/\d{4,}/g, (m) => '•'.repeat(m.length));
}

/**
 * Record an inbound message. Returns { isNew } — false when the provider
 * redelivered a message we already processed (dedup on provider_message_id).
 * The stored body is redacted; the caller passes the original text to the bot.
 */
async function recordInbound({ provider, providerMessageId, phone, toNumber = null, body = null, organizationId = null, clientId = null }) {
  const [res] = await primaryQuery(
    `INSERT IGNORE INTO whatsapp_inbound_messages
       (organization_id, client_id, provider, provider_message_id, phone_e164, to_number, body, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [organizationId, clientId, provider, providerMessageId, phone, toNumber, redactSecrets(body)],
  );
  return { isNew: res.affectedRows > 0 };
}

/** Backfill the resolved org/client onto an inbound row once the sender is bound. */
async function setInboundOwner({ provider, providerMessageId, clientId, organizationId }) {
  try {
    await primaryQuery(
      `UPDATE whatsapp_inbound_messages SET client_id = ?, organization_id = ?
        WHERE provider = ? AND provider_message_id = ?`,
      [clientId, organizationId, provider, providerMessageId],
    );
  } catch (err) {
    logger.warn({ err }, 'whatsapp: setInboundOwner failed');
  }
}

/** Recent inbound-message count from a phone — a coarse per-phone abuse throttle. */
async function recentInboundCount(phone, minutes = 60) {
  const [rows] = await primaryQuery(
    `SELECT COUNT(*) AS n FROM whatsapp_inbound_messages
      WHERE phone_e164 = ? AND received_at > (NOW() - INTERVAL ? MINUTE)`,
    [phone, minutes],
  );
  return rows[0]?.n || 0;
}

// ---------------------------------------------------------------------------
// Multi-turn conversation state (the bot's short flows: report-a-problem, etc.)
// ---------------------------------------------------------------------------

const CONVERSATION_STATE_TTL_MIN = 15;

/** Current (non-stale) conversation state for a phone, or null. */
async function getConversationState(phone) {
  const [rows] = await primaryQuery(
    `SELECT client_id, state, context FROM whatsapp_conversation_state
      WHERE phone_e164 = ? AND updated_at > (NOW() - INTERVAL ? MINUTE) LIMIT 1`,
    [phone, CONVERSATION_STATE_TTL_MIN],
  );
  const r = rows[0];
  if (!r) return null;
  let context = null;
  if (r.context) {
    try { context = typeof r.context === 'string' ? JSON.parse(r.context) : r.context; }
    catch (_e) { context = null; }
  }
  return { clientId: r.client_id, state: r.state, context };
}

/** Upsert the conversation state for a phone (resets the TTL clock). */
async function setConversationState(phone, clientId, state, context = null) {
  await primaryQuery(
    `INSERT INTO whatsapp_conversation_state (phone_e164, client_id, state, context)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE client_id = VALUES(client_id), state = VALUES(state),
       context = VALUES(context), updated_at = NOW()`,
    [phone, clientId, state, context ? JSON.stringify(context) : null],
  );
}

/** Clear a phone's conversation state (flow finished or abandoned). */
async function clearConversationState(phone) {
  await primaryQuery('DELETE FROM whatsapp_conversation_state WHERE phone_e164 = ?', [phone]);
}

module.exports = {
  normalizeSenderId,
  clientLinkGuessesExhausted,
  CLIENT_LINK_GUESSES_PER_DAY,
  normalizeE164,
  generateNumericCode,
  hashCode,
  hexEqual,
  emailCodeBudgetExceeded,
  clientEmailCodeBudgetExceeded,
  createVerification,
  createPortalLinkCode,
  pendingPortalCodeCount,
  verifyPhoneCode,
  verifyPortalCode,
  bindNumber,
  resolveBinding,
  touchBinding,
  listClientLinks,
  revokeLink,
  revokeClientLinks,
  recordInbound,
  redactSecrets,
  setInboundOwner,
  recentInboundCount,
  getConversationState,
  setConversationState,
  clearConversationState,
  PORTAL_CODE_LENGTH,
  EMAIL_CODE_LENGTH,
};
