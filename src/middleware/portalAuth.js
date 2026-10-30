// =============================================================================
// VigaBSS 5.0 — Portal Authentication Middleware
// =============================================================================
// Validates a portal JWT token and attaches req.client with:
//   { id, organizationId, type: 'portal' }
//
// Portal tokens are signed with a portal-only derived key, carry
// { type: 'portal', aud: 'vigabss-portal' }, and are rejected by the staff
// authenticate() middleware and WebSocket hub; staff tokens fail verification
// here. See src/utils/accessTokens.js.
// =============================================================================

const db = require('../config/database');
const { UnauthorizedError } = require('../utils/errors');
const { verifyPortalAccessToken } = require('../utils/accessTokens');

/**
 * Require portal authentication.
 * Sets req.client = { id, organizationId }.
 */
async function portalAuthenticate(req, _res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }

    const token = header.slice(7);
    let payload;
    try {
      payload = verifyPortalAccessToken(token);
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }

    const [rows] = await db.query(
      'SELECT id, organization_id, name, email, status FROM clients WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [payload.sub],
    );

    const client = rows[0];
    if (!client || client.status === 'inactive') {
      throw new UnauthorizedError('Client not found or inactive');
    }

    req.client = {
      id: client.id,
      // Never undefined: NULL (single-tenant) is a real, null-safe-comparable
      // org value; services refuse an undefined org (utils/requireOrgId.js).
      organizationId: client.organization_id ?? null,
      name: client.name,
      email: client.email,
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { portalAuthenticate };
