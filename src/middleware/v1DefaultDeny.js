// =============================================================================
// SEC-22 — every v1 route authenticates by default
// =============================================================================
// Each of the ~180 route files used to add authenticate itself, so a route in
// a file that forgot it was public. applyDefaultDeny() now puts authenticate
// in front of the handlers of every route in the v1 tree, except the routes
// below, which either authenticate in their own way (portal session, provider
// signature, shared secret, relay token) or must be reachable before a staff
// session exists. It guards routes rather than the whole router, so an
// unknown path still falls through to 404 and /api/docs. authenticate is
// idempotent, so the route files' own guards still apply unchanged.
// tests/routeSecurityInventory.test.js checks every route against this list
// and against authenticate + orgScope + requirePermission.
// =============================================================================

const { authenticate } = require('./auth');

// [method or '*', path pattern relative to the v1 mount, why it is public]
const PUBLIC_V1_ROUTES = [
  ['POST', /^\/auth\/(login|login\/2fa|logout|refresh|verify-email|password-reset|password-reset\/request)$/, 'staff sign-in before a session exists'],
  ['*', /^\/portal(\/|$)/, 'subscriber portal: portalAuthenticate, or portal sign-in'],
  ['POST', /^\/payment-webhooks\/(stripe|conekta)(\/[^/]+){0,2}$/, 'payment provider callbacks, verified by provider signature'],
  ['*', /^\/whatsapp\/webhook$/, 'WhatsApp verification handshake and callbacks, verified by signature'],
  ['POST', /^\/communication\/delivery-webhook$/, 'message delivery callbacks, verified in the handler'],
  ['GET', /^\/firerelay\/health$/, 'relay agents: requireRelayToken'],
  ['*', /^\/sso\/[^/]+\/(saml|oidc)\//, 'SSO browser flow before a session exists'],
  ['GET', /^\/changelog$/, 'public release notes'],
  ['POST', /^\/pppoe\/events$/, 'router event collector: requireEventsSecret'],
  ['POST', /^\/radius\/accounting$/, 'RADIUS accounting collector, authenticated in the handler'],
];

function isPublicV1Route(method, path) {
  return PUBLIC_V1_ROUTES.some(([m, pattern]) => (m === '*' || m === method) && pattern.test(path));
}

// The path below the v1 mount: /api/v1/clients is /clients.
function v1Path(req) {
  const path = (req.originalUrl || req.url).split('?')[0];
  const match = /^\/api\/v1(?=\/|$)/.exec(path);
  return match ? path.slice(match[0].length) || '/' : path;
}

function defaultDenyGuard(req, res, next) {
  if (isPublicV1Route(req.method === 'HEAD' ? 'GET' : req.method, v1Path(req))) return next();
  return authenticate(req, res, next);
}

const GUARDED = Symbol('defaultDeny');

// Put defaultDenyGuard first in every route of the tree, for every method.
function applyDefaultDeny(router) {
  for (const layer of router.stack) {
    if (layer.route && !layer.route[GUARDED]) {
      const { route } = layer;
      const handlesAll = route.methods._all;
      route.all(defaultDenyGuard);
      if (!handlesAll) delete route.methods._all;
      route.stack.unshift(route.stack.pop());
      route[GUARDED] = true;
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      applyDefaultDeny(layer.handle);
    }
  }
}

module.exports = { applyDefaultDeny, defaultDenyGuard, isPublicV1Route, PUBLIC_V1_ROUTES };
