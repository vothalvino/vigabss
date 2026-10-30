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
//      that group is designed for reseller staff, and before migration 475 it
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

async function resolveResellerScope(user, orgId) {
  if (user.hasGlobalOrganizationAccess && !user.apiTokenId) return { all: true };

  const [[binding]] = await db.query(
    `SELECT b.reseller_id, r.id AS live_reseller_id
       FROM reseller_user_bindings b
       LEFT JOIN resellers r
         ON r.id = b.reseller_id AND r.organization_id = b.organization_id AND r.deleted_at IS NULL
      WHERE b.organization_id = ? AND b.user_id = ?
      LIMIT 1`,
    [orgId, user.id],
  );
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
    req.resellerScope = await resolveResellerScope(req.user, req.orgId);
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
  resellerScope,
  resellerInScope,
  assertResellerInScope,
  RESELLER_GROUP_NAMES,
};
