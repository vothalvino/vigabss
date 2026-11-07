// =============================================================================
// VigaBSS 5.0 — Reseller fence
// =============================================================================
// A user bound to a reseller (reseller_user_bindings) in the active
// organization works in the reseller app. Whatever permissions its group
// holds, the fence lets it reach only the v1 path prefixes below; everything
// else is 403. It applies to sessions and API tokens alike, and not to a
// validated global-access principal (resellerScope treats those as
// org-level too).
//
// Mounted on the v1 router before the route mounts. It never runs for a
// public route or a request without staff credentials, and an allowed prefix
// is passed through without any lookup. Otherwise it authenticates (route
// guards are idempotent, so the route does not do it again) and looks up the
// binding once for the request (resellerScope.bindingForRequest). A failed
// authentication is left to the route's own guard, which answers it.
//
// The staff WebSocket hub is outside the v1 router; it applies the same rule
// itself (services/realtimeAccess.resellerBound), and long-lived streams are
// ended when their user is bound (realtimeAccess.stillAuthorized).
// =============================================================================

const { authenticate } = require('./auth');
const { isPublicV1Route } = require('./v1DefaultDeny');
const { isResellerBound, requestBindingChecksAvailable } = require('./resellerScope');
const { ForbiddenError } = require('../utils/errors');

// [prefix, why a bound user needs it]
const RESELLER_ALLOWED_PREFIXES = [
  ['/auth', 'sign-in, /auth/me, sessions, password change, organization switch'],
  ['/2fa', 'the user\'s own two-factor setup'],
  ['/notifications', 'the user\'s own notifications'],
  ['/reseller-app', 'the reseller app'],
  ['/resellers', 'reseller-scoped by resellerScope'],
  ['/reseller-portal', 'reseller-scoped by resellerScope'],
];

function isResellerAllowedPath(path) {
  return RESELLER_ALLOWED_PREFIXES.some(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
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
  if (isPublicV1Route(method, path) || isResellerAllowedPath(path) || !hasStaffCredential(req)) {
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
    if (await isResellerBound(req, req.user.organizationId)) {
      return next(new ForbiddenError('Reseller accounts can only use the reseller app'));
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { resellerFence, isResellerAllowedPath, RESELLER_ALLOWED_PREFIXES };
