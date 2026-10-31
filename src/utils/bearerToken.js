// =============================================================================
// VigaBSS 5.0 — bearerToken
// =============================================================================
// The staff SPA authenticates with the httpOnly `fireisp_access` cookie after
// a page reload: the in-memory access token is gone until the next refresh.
// Several pages still sent `Authorization: Bearer ${token}` regardless, so
// the header arrived as "Bearer null" or "Bearer " and, because a Bearer
// header takes precedence over the cookie, every request failed with 401
// (FE-03). A placeholder value like that carries no credential: it is
// treated as no header at all, so the cookie (and, for writes, the CSRF
// check) applies.
// =============================================================================

const PLACEHOLDERS = new Set(['', 'null', 'undefined']);

/**
 * The bearer token from the Authorization header, or null when there is no
 * Bearer header or it only carries a placeholder.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function bearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return PLACEHOLDERS.has(token) ? null : token;
}

module.exports = { bearerToken };
