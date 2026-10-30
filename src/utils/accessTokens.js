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
// =============================================================================

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const PORTAL_AUDIENCE = 'vigabss-portal';
const PORTAL_KEY_INFO = 'vigabss portal access token v1';

function portalSigningKey() {
  return Buffer.from(crypto.hkdfSync('sha256', config.jwt.secret, '', PORTAL_KEY_INFO, 32));
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
  verifyStaffAccessToken,
  signPortalAccessToken,
  verifyPortalAccessToken,
};
