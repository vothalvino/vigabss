// =============================================================================
// VigaBSS 5.0 — reseller collect token (reseller app, phase 2)
// =============================================================================
// A reseller may collect from any subscriber of the ISP, but it only finds one
// that is not its own by an exact customer number or phone, and it never sees
// that client's id-bearing record. The lookup hands it a short-lived token
// naming the client; POST /reseller-app/payments takes the token, not a client
// id, so a reseller cannot collect against an id it guessed.
//
// The token binds the organization, the client, the collecting (top-level)
// reseller and an expiry, and is signed with HMAC-SHA256 under a key derived
// from JWT_SECRET with its own HKDF label (ARCHITECTURE.md: never reuse the
// secret itself). Format: base64url(JSON payload) "." base64url(HMAC).
// =============================================================================

const crypto = require('crypto');
const config = require('../config');

const KEY_INFO = 'vigabss reseller collect token v1';
const COLLECT_TOKEN_TTL_SECONDS = 15 * 60;

function signingKey() {
  return Buffer.from(crypto.hkdfSync('sha256', config.jwt.secret, '', KEY_INFO, 32));
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function mac(payloadPart) {
  return crypto.createHmac('sha256', signingKey()).update(payloadPart).digest();
}

/**
 * @param {{ orgId: number, clientId: number, rootResellerId: number }} claims
 * @param {number} [nowMs]
 * @returns {string}
 */
function signCollectToken({ orgId, clientId, rootResellerId }, nowMs = Date.now()) {
  const payload = {
    o: Number(orgId),
    c: Number(clientId),
    r: Number(rootResellerId),
    exp: Math.floor(nowMs / 1000) + COLLECT_TOKEN_TTL_SECONDS,
  };
  const part = b64url(JSON.stringify(payload));
  return `${part}.${b64url(mac(part))}`;
}

/**
 * Verify a token for the caller. Returns { ok: true, clientId } or
 * { ok: false, reason: 'invalid' | 'expired' }. A token for another
 * organization or reseller is 'invalid', exactly like a forged one.
 * @param {unknown} token
 * @param {{ orgId: number, rootResellerId: number }} expected
 * @param {number} [nowMs]
 */
function verifyCollectToken(token, { orgId, rootResellerId }, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length > 512) return { ok: false, reason: 'invalid' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'invalid' };
  const [part, sig] = parts;
  let given;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch (_err) {
    return { ok: false, reason: 'invalid' };
  }
  const expected = mac(part);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'invalid' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch (_err) {
    return { ok: false, reason: 'invalid' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'invalid' };
  if (payload.o !== Number(orgId) || payload.r !== Number(rootResellerId)) return { ok: false, reason: 'invalid' };
  if (!Number.isInteger(payload.c) || payload.c < 1 || !Number.isInteger(payload.exp)) return { ok: false, reason: 'invalid' };
  if (payload.exp * 1000 <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, clientId: payload.c };
}

module.exports = { signCollectToken, verifyCollectToken, COLLECT_TOKEN_TTL_SECONDS };
