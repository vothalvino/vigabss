// =============================================================================
// Refresh tokens stay out of reach of page scripts (SEC-28)
// =============================================================================
// A browser keeps its refresh token in an httpOnly cookie. The login and
// refresh responses also returned it in JSON, so any XSS in the SPA could
// mint a long-lived token and send it away. A browser request is recognized
// by Sec-Fetch-Site, which every current browser sends on fetch and page
// scripts cannot remove, or by a refresh token that arrived in the cookie.
// Programmatic API clients send neither and still get the token in JSON.
// =============================================================================

function isBrowserRequest(req) {
  return Boolean(req.get?.('sec-fetch-site'));
}

/**
 * The token response body for this request: without refreshToken for a
 * browser, unchanged for an API client.
 */
function tokenResponseBody(req, data, { tokenFromCookie = false } = {}) {
  if (!data || !(tokenFromCookie || isBrowserRequest(req))) return data;
  const { refreshToken: _omitted, ...rest } = data;
  return rest;
}

module.exports = { isBrowserRequest, tokenResponseBody };
