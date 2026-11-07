// =============================================================================
// VigaBSS 5.0 — Reseller scope (audit TNB-13)
// =============================================================================
// Resolves, server-side, which resellers the caller may act on within the
// active organization, and exposes it as req.resellerScope:
//
//   { all: true }                                  org-level staff
//   { all: false, rootId, resellerIds: [...] }     bound reseller user
//
// Resolution:
//   1. A validated global-access principal (never an API token) sees all.
//   2. A reseller_user_bindings row for (org, user) confines the caller to
//      that reseller's subtree (the reseller plus its sub-resellers). The
//      binding wins over any permission the user holds. A binding whose
//      reseller was deleted or left the organization fails closed (403).
//   3. An unbound user in the seeded reseller_admin group fails closed (403):
//      that group is designed for reseller staff, and before migration 471 it
//      could read every reseller's customers and bank details.
//   4. Any other unbound user is org-level staff: requirePermission on each
//      route remains the only gate, exactly as before.
//
// Reseller scoping is a business filter inside the tenant boundary; every
// query still binds organization_id (see ARCHITECTURE.md).
// =============================================================================

const db = require('../config/database');
const { ForbiddenError, NotFoundError } = require('../utils/errors');
const resellerService = require('../services/resellerService');
const { runInPrimaryContext } = require('../utils/primaryContext');

const RESELLER_GROUP_NAMES = new Set(['reseller_admin']);

// One binding lookup per request: the fence (middleware/resellerFence.js),
// resellerScope and the reseller app all ask the same question.
const BINDING = Symbol('resellerBinding');

/**
 * The caller's reseller_user_bindings row in `orgId`, or null:
 * { reseller_id, live_reseller_id, reseller_name } where live_reseller_id and
 * reseller_name are null when the bound reseller was deleted or left the
 * organization. The binding lives beside `resellers`, in the organization's
 * own database when it is isolated.
 */
async function lookupBinding(userId, orgId) {
  const run = () => db.query(
    `SELECT b.reseller_id, r.id AS live_reseller_id, r.name AS reseller_name
       FROM reseller_user_bindings b
       LEFT JOIN resellers r
         ON r.id = b.reseller_id AND r.organization_id = b.organization_id AND r.deleted_at IS NULL
      WHERE b.organization_id = ? AND b.user_id = ?
      LIMIT 1`,
    [orgId, userId],
  );
  const [rows] = typeof db.withTenantContext === 'function'
    ? await db.withTenantContext(orgId, run)
    : await run();
  const row = rows && rows[0];
  // reseller_id is NOT NULL: a row without it is not a binding.
  return row && row.reseller_id !== null && row.reseller_id !== undefined ? row : null;
}

/**
 * Whether the request-wide binding checks (the fence, /auth/me) can run: the
 * database module has the tenant-context primitive, which src/config/database
 * always exports. Many older unit tests replace that module with a
 * query-only double that knows nothing of bindings; like orgScope and
 * services/orgPrincipalService.js, those keep their original route behavior.
 * resellerScope itself always looks the binding up.
 */
function requestBindingChecksAvailable() {
  return typeof db.withTenantContext === 'function';
}

/** lookupBinding for the request's principal, memoized on the request. */
async function bindingForRequest(req, orgId = req.orgId ?? req.user?.organizationId) {
  if (!req.user || !orgId) return null;
  const key = `${orgId}:${req.user.id}`;
  if (req[BINDING] && req[BINDING].key === key) return req[BINDING].row;
  const row = await lookupBinding(req.user.id, orgId);
  req[BINDING] = { key, row };
  return row;
}

/**
 * True when the principal is confined to a reseller: it has a binding in the
 * organization and is not a validated global-access principal (an API token
 * never is).
 */
async function isResellerBound(req, orgId) {
  if (!req.user) return false;
  if (req.user.hasGlobalOrganizationAccess && !req.user.apiTokenId) return false;
  return Boolean(await bindingForRequest(req, orgId));
}

async function resolveResellerScope(user, orgId, binding) {
  if (user.hasGlobalOrganizationAccess && !user.apiTokenId) return { all: true };

  if (binding === undefined) binding = await lookupBinding(user.id, orgId);
  if (binding) {
    if (!binding.live_reseller_id) {
      throw new ForbiddenError('Your reseller binding is no longer valid; contact an administrator');
    }
    const rootId = Number(binding.reseller_id);
    const resellerIds = (await resellerService.getResellerSubtree([rootId], orgId)).map(Number);
    return { all: false, rootId, resellerIds };
  }

  // Staff identities and groups live in the primary database (as in
  // requirePermission); the binding above lives beside `resellers`.
  const [[group]] = await runInPrimaryContext(() => db.query(
    `SELECT g.name AS group_name
       FROM users u
       JOIN roles g ON g.id = u.group_id AND g.deleted_at IS NULL
      WHERE u.id = ? AND u.deleted_at IS NULL
      LIMIT 1`,
    [user.id],
  ));
  if (group && RESELLER_GROUP_NAMES.has(group.group_name)) {
    throw new ForbiddenError('Your account is not bound to a reseller; contact an administrator');
  }
  return { all: true };
}

/** Express middleware: sets req.resellerScope. Mount after authenticate + orgScope. */
async function resellerScope(req, _res, next) {
  try {
    if (!req.user || !req.orgId) throw new ForbiddenError('No organization context');
    const binding = req.user.hasGlobalOrganizationAccess && !req.user.apiTokenId
      ? null
      : await bindingForRequest(req);
    req.resellerScope = await resolveResellerScope(req.user, req.orgId, binding);
    next();
  } catch (err) { next(err); }
}

/** True when the reseller id is inside the caller's scope. */
function resellerInScope(scope, resellerId) {
  if (!scope) return false;
  if (scope.all) return true;
  const id = Number(resellerId);
  return Number.isInteger(id) && scope.resellerIds.includes(id);
}

/**
 * 404 (not 403) for a reseller outside the caller's subtree, so a bound user
 * cannot use the status code to probe which reseller ids exist.
 */
function assertResellerInScope(req, resellerId) {
  if (!resellerInScope(req.resellerScope, resellerId)) throw new NotFoundError('Reseller not found');
}

module.exports = {
  resolveResellerScope,
  lookupBinding,
  bindingForRequest,
  requestBindingChecksAvailable,
  isResellerBound,
  resellerScope,
  resellerInScope,
  assertResellerInScope,
  RESELLER_GROUP_NAMES,
};
