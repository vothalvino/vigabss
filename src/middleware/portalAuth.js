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
const { tokenVersionStale } = require('../services/sessionRevocation');

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

    // Like orgScope for staff, the rest of the request runs in the client's
    // organization's database context, so a subscriber of an isolated
    // organization reads and writes that organization's database (TNB-27).
    // The token's organization is checked against the client row.
    const orgId = payload.orgId ?? null;
    const run = callback => (orgId === null || typeof db.withTenantContext !== 'function'
      ? callback()
      : db.withTenantContext(orgId, callback));

    await run(async () => {
      const [rows] = await db.query(
        'SELECT id, organization_id, name, email, status, portal_token_version FROM clients WHERE id = ? AND deleted_at IS NULL LIMIT 1',
        [payload.sub],
      );

      const client = rows[0];
      if (!client || client.status === 'inactive') {
        throw new UnauthorizedError('Client not found or inactive');
      }
      if (orgId !== null && Number(client.organization_id) !== Number(orgId)) {
        throw new UnauthorizedError('Client not found or inactive');
      }
      if (tokenVersionStale(payload.tv, client.portal_token_version)) {
        throw new UnauthorizedError('Session has been revoked');
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
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { portalAuthenticate };
