// =============================================================================
// VigaBSS 5.0 — Reseller and carrier fence
// =============================================================================
// Two kinds of staff account work in an app of their own and nowhere else of
// the staff API, whatever permissions their group holds:
//
//   * a user bound to a reseller (reseller_user_bindings) in the active
//     organization: the reseller app (/punto);
//   * a carrier, a user in the seeded 'carrier' group (migration 005,
//     services/carrierAccount.js): the carrier app (/ruta).
//
// Both reach the account prefixes below; a bound user also the reseller
// prefixes, a carrier also the carrier prefix. Everything else is 403. It
// applies to sessions and API tokens alike, and not to a validated
// global-access principal (resellerScope treats those as org-level too). A
// user who is somehow both gets only the account prefixes.
//
// Mounted on the v1 router before the route mounts. It never runs for a
// public route or a request without staff credentials, and an account prefix
// is passed through without any lookup. Otherwise it authenticates (route
// guards are idempotent, so the route does not do it again), checks the
// carrier group (no lookup for a user without a group) and looks the binding
// up once for the request (resellerScope.bindingForRequest). A failed
// authentication is left to the route's own guard, which answers it.
//
// The staff WebSocket hub is outside the v1 router; it applies the same rule
// itself (services/realtimeAccess.resellerBound and carrierAccount), and
// long-lived streams are ended when their user is bound or becomes a carrier
// (realtimeAccess.stillAuthorized).
// =============================================================================

const { authenticate } = require('./auth');
const { isPublicV1Route } = require('./v1DefaultDeny');
const { isResellerBound, requestBindingChecksAvailable } = require('./resellerScope');
const { isCarrierRequest } = require('../services/carrierAccount');
const { ForbiddenError } = require('../utils/errors');

// [prefix, why a fenced account needs it]
const ACCOUNT_PREFIXES = [
  ['/auth', 'sign-in, /auth/me, sessions, password change, organization switch'],
  ['/2fa', 'the user\'s own two-factor setup'],
  ['/security-admin/webauthn', 'the user\'s own passkeys: listed and revoked per user (webauthn.*)'],
  ['/notifications', 'the user\'s own notifications'],
];

const RESELLER_PREFIXES = [
  ['/reseller-app', 'the reseller app'],
  ['/resellers', 'reseller-scoped by resellerScope'],
  ['/reseller-portal', 'reseller-scoped by resellerScope'],
];

const CARRIER_PREFIXES = [
  ['/carrier-app', 'the carrier app'],
];

// Every prefix a bound user, or a carrier, may reach.
const RESELLER_ALLOWED_PREFIXES = [...ACCOUNT_PREFIXES, ...RESELLER_PREFIXES];
const CARRIER_ALLOWED_PREFIXES = [...ACCOUNT_PREFIXES, ...CARRIER_PREFIXES];

const under = (list, path) => list.some(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));

function isResellerAllowedPath(path) {
  return under(RESELLER_ALLOWED_PREFIXES, path);
}

function isCarrierAllowedPath(path) {
  return under(CARRIER_ALLOWED_PREFIXES, path);
}

function hasStaffCredential(req) {
  if (req.headers['x-api-key']) return true;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return true;
  return Boolean(req.cookies?.fireisp_access);
}

async function resellerFence(req, res, next) {
  const path = req.path || '/';
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  if (isPublicV1Route(method, path) || under(ACCOUNT_PREFIXES, path) || !hasStaffCredential(req)) {
    return next();
  }
  if (!requestBindingChecksAvailable()) return next();

  let authError = null;
  await new Promise((resolve) => {
    authenticate(req, res, (err) => { authError = err || null; resolve(); });
  });
  // The route's own authenticate answers a bad credential (or a 404 answers
  // an unknown path), exactly as without the fence.
  if (authError || !req.user) return next();

  try {
    if (!isCarrierAllowedPath(path) && await isCarrierRequest(req)) {
      return next(new ForbiddenError('Carrier accounts can only use the carrier app'));
    }
    if (!isResellerAllowedPath(path) && await isResellerBound(req, req.user.organizationId)) {
      return next(new ForbiddenError('Reseller accounts can only use the reseller app'));
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  resellerFence,
  isResellerAllowedPath,
  isCarrierAllowedPath,
  RESELLER_ALLOWED_PREFIXES,
  CARRIER_ALLOWED_PREFIXES,
};
