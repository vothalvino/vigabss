// =============================================================================
// VigaBSS 5.0 — Access Token Helpers
// =============================================================================
// Staff and subscriber-portal access JWTs must never be interchangeable.
//
// - Staff tokens are signed with JWT_SECRET.
// - Portal tokens are signed with a key derived from JWT_SECRET (HKDF, distinct
//   label) and carry `aud: vigabss-portal` plus `type: 'portal'`, so a portal
//   token cannot verify on a staff surface and vice versa.
// - verifyStaffAccessToken() additionally rejects any token claiming the portal
//   type or audience, which covers portal tokens issued before the key split.
// - Staff two-factor login challenges (`type: 'mfa'`) are signed with a third
//   derived key and audience. They prove only "password accepted, second
//   factor pending" and must never authenticate a request.
// =============================================================================

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const PORTAL_AUDIENCE = 'vigabss-portal';
const PORTAL_KEY_INFO = 'vigabss portal access token v1';
const MFA_AUDIENCE = 'vigabss-mfa';
const MFA_KEY_INFO = 'vigabss staff mfa challenge token v1';
const MFA_CHALLENGE_SECONDS = 300;

function portalSigningKey() {
  return Buffer.from(crypto.hkdfSync('sha256', config.jwt.secret, '', PORTAL_KEY_INFO, 32));
}

function mfaSigningKey() {
  return Buffer.from(crypto.hkdfSync('sha256', config.jwt.secret, '', MFA_KEY_INFO, 32));
}

function isMfaPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.type === 'mfa') return true;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return aud.includes(MFA_AUDIENCE);
}

function isPortalPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.type === 'portal') return true;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return aud.includes(PORTAL_AUDIENCE);
}

/**
 * Verify a staff access JWT. Throws on an invalid signature, expiry, or a
 * subscriber-portal token.
 */
function verifyStaffAccessToken(token) {
  const payload = jwt.verify(token, config.jwt.secret, { algorithms: [config.jwt.algorithm] });
  if (isPortalPayload(payload)) throw new Error('Portal tokens are not valid staff credentials');
  if (isMfaPayload(payload)) throw new Error('Two-factor challenge tokens are not valid staff credentials');
  return payload;
}

/**
 * Fingerprint of the user's current password hash. Embedded in a challenge so
 * a password change invalidates every outstanding challenge for that account.
 */
function passwordFingerprint(passwordHash) {
  return crypto.createHash('sha256').update(String(passwordHash || '')).digest('hex').slice(0, 32);
}

/**
 * Sign a short-lived staff two-factor login challenge. It is not a session:
 * authenticate() cannot verify it (different key, audience and type), and the
 * only consumer is POST /auth/login/2fa.
 *
 * @param {{ userId: number, passwordHash: string, organizationId?: number|null, method?: 'password'|'sso' }} claims
 */
function signMfaChallengeToken({ userId, passwordHash, organizationId = null, method = 'password' }) {
  const payload = { sub: userId, type: 'mfa', method, pwf: passwordFingerprint(passwordHash) };
  if (organizationId !== null && organizationId !== undefined) payload.orgId = organizationId;
  return jwt.sign(payload, mfaSigningKey(), {
    expiresIn: MFA_CHALLENGE_SECONDS,
    algorithm: config.jwt.algorithm,
    audience: MFA_AUDIENCE,
    jwtid: crypto.randomUUID(),
  });
}

/** Verify a staff two-factor login challenge. Throws on anything else. */
function verifyMfaChallengeToken(token) {
  const payload = jwt.verify(token, mfaSigningKey(), {
    algorithms: [config.jwt.algorithm],
    audience: MFA_AUDIENCE,
  });
  if (!payload || payload.type !== 'mfa') throw new Error('Invalid token type');
  return payload;
}

/**
 * Sign a subscriber-portal access JWT.
 */
function signPortalAccessToken({ clientId, organizationId }, expiresInSeconds) {
  return jwt.sign(
    { sub: clientId, orgId: organizationId, type: 'portal' },
    portalSigningKey(),
    { expiresIn: expiresInSeconds, algorithm: config.jwt.algorithm, audience: PORTAL_AUDIENCE },
  );
}

/**
 * Verify a subscriber-portal access JWT. Throws unless it was signed with the
 * portal key for the portal audience.
 */
function verifyPortalAccessToken(token) {
  const payload = jwt.verify(token, portalSigningKey(), {
    algorithms: [config.jwt.algorithm],
    audience: PORTAL_AUDIENCE,
  });
  if (!payload || payload.type !== 'portal') throw new Error('Invalid token type');
  return payload;
}

module.exports = {
  PORTAL_AUDIENCE,
  MFA_AUDIENCE,
  MFA_CHALLENGE_SECONDS,
  verifyStaffAccessToken,
  signMfaChallengeToken,
  verifyMfaChallengeToken,
  passwordFingerprint,
  signPortalAccessToken,
  verifyPortalAccessToken,
};
