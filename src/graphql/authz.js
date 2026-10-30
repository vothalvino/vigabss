// =============================================================================
// VigaBSS 5.0 — GraphQL authorization helper
// =============================================================================
// Shared RBAC guard for GraphQL, mirroring the REST requirePermission layer in
// src/middleware/rbac.js: enforceTokenScopes (so a scope-limited API token is
// bound) → validated global-access principal bypass (never for API tokens) →
// org-scoped permission lookup in the primary database. Used by index.js to
// gate root queries/mutations and nested type fields, and by resolvers.js to
// gate subscriptions and the billing-ticket rule. Kept in its own module so
// resolvers.js can require it without a cycle through index.js.
//
// The granted permission set is memoized per request on the GraphQL context:
// a single query can resolve hundreds of guarded nested fields (one per parent
// row), and each must not cost a permission lookup.
// =============================================================================

const { GraphQLError } = require('graphql');
const { enforceTokenScopes } = require('../middleware/rbac');
const User = require('../models/User');
const db = require('../config/database');
const { runInPrimaryContext } = require('../utils/primaryContext');

function gqlForbidden(message) {
  return new GraphQLError(message, { extensions: { code: 'FORBIDDEN' } });
}

/**
 * Principal bypass, identical to requirePermission: an installation operator
 * or exact system super-admin (hasGlobalOrganizationAccess, set by
 * authenticate) carries full authority, but an API token never does. A tenant
 * `users.role = 'admin'` is NOT a bypass in production (SEC-06); it resolves
 * through the permission graph like REST.
 *
 * The last clause mirrors rbac.js#isLegacyTestAdmin — a compatibility path
 * that only exists inside NODE_ENV=test for query-only database doubles. It is
 * inlined rather than imported because many suites replace the rbac module
 * with a partial mock.
 */
function hasPermissionBypass(user) {
  if (user.apiTokenId) return false;
  if (user.hasGlobalOrganizationAccess) return true;
  return process.env.NODE_ENV === 'test'
    && typeof db.withPrimaryContext !== 'function'
    && user.role === 'admin';
}

/** Per-request memoized permission set (the in-flight promise is cached). */
function getGrantedPermissions(ctx) {
  if (!ctx._grantedPermissions) {
    const { user } = ctx;
    ctx._grantedPermissions = Promise.resolve(
      runInPrimaryContext(() => User.getPermissions(user.id, user.organizationId)),
    ).then((perms) => (Array.isArray(perms) ? perms : []));
  }
  return ctx._grantedPermissions;
}

/**
 * Non-throwing probe: does the caller hold ANY of `perms`, after API-token
 * scope enforcement? Mirrors rbac.js#userHasPermission.
 */
async function graphqlHasPermission(ctx, perms) {
  const user = ctx && ctx.user;
  if (!user || !user.organizationId) return false;
  if (typeof enforceTokenScopes === 'function') {
    try {
      enforceTokenScopes(user, perms);
    } catch {
      return false;
    }
  }
  if (hasPermissionBypass(user)) return true;
  const granted = await getGrantedPermissions(ctx);
  return perms.some((p) => granted.includes(p));
}

async function assertGraphqlPermission(ctx, perms) {
  const user = ctx && ctx.user;
  if (!user || !user.organizationId) {
    throw gqlForbidden('Not authorized');
  }
  // API-token scope enforcement runs first (no-op for JWT users / unrestricted
  // tokens), exactly like the REST layer where it precedes the principal bypass.
  if (typeof enforceTokenScopes === 'function') {
    try {
      enforceTokenScopes(user, perms);
    } catch (err) {
      throw gqlForbidden(err.message || 'API token scope insufficient');
    }
  }
  if (hasPermissionBypass(user)) return;
  const granted = await getGrantedPermissions(ctx);
  if (!perms.some((p) => granted.includes(p))) {
    throw gqlForbidden('Forbidden: requires ' + perms.join(' or '));
  }
}

module.exports = { gqlForbidden, assertGraphqlPermission, graphqlHasPermission };
