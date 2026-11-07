// =============================================================================
// VigaBSS 5.0 — who may receive which real-time event (SEC-09)
// =============================================================================
// The SSE streams (/events/*) and the browser WebSocket hub checked only that
// the caller was authenticated in the organization. Every staff persona and
// any API token received the organization's invoice totals, payment amounts,
// ticket subjects and device events, and authentication ran once at connect.
//
// A channel needs the slug its REST counterpart needs. On the notifications
// channel each event is delivered only to subscribers holding the event's
// slug; an event with no entry here is not delivered at all (fail closed).
// Long-lived subscriptions are re-checked periodically, so a deactivated,
// archived or revoked account (SEC-10 token version) loses its stream.
// =============================================================================

const db = require('../config/database');
const { userHasPermission } = require('../middleware/rbac');
const { tokenVersionStale } = require('./sessionRevocation');

const EVENT_PERMISSIONS = [
  ['invoice.', 'invoices.view'],
  ['payment.', 'payments.view'],
  ['ticket.', 'tickets.view'],
  ['contract.', 'contracts.view'],
  ['service_order.', 'service_orders.view'],
  ['device.', 'devices.view'],
  ['pppoe.', 'devices.view'],
  ['outage.', 'outages.view'],
  ['followup.', 'follow_ups.view'],
  ['survey.', 'surveys.view'],
  ['maintenance.', 'maintenance_windows.view'],
];

const CHANNEL_PERMISSIONS = {
  notifications: [],
  metrics: ['devices.view'],
  outages: ['outages.view'],
  ticket: ['tickets.view'],
};

const REVALIDATE_MS = 60 * 1000;

const SLUGS = [...new Set([...EVENT_PERMISSIONS.map(([, slug]) => slug), 'tickets.view_billing'])];

function eventPermission(event) {
  const hit = EVENT_PERMISSIONS.find(([prefix]) => String(event).startsWith(prefix));
  return hit ? hit[1] : null;
}

/**
 * Resolve once, at connect, which event slugs this subscriber holds.
 * @param {{ user: object }} req an authenticated request (or a stand-in with req.user)
 * @returns {Promise<Set<string>>}
 */
async function resolveGrants(req) {
  const granted = new Set();
  for (const slug of SLUGS) {
    if (await userHasPermission(req, slug)) granted.add(slug);
  }
  return granted;
}

/** True when a subscriber with these grants may receive this event. */
function mayReceive(grants, event, data) {
  const slug = eventPermission(event);
  if (!slug || !grants.has(slug)) return false;
  if (slug === 'tickets.view' && data && data.category === 'billing' && !grants.has('tickets.view_billing')) return false;
  return true;
}

/** True when the caller may subscribe to the channel kind (notifications, metrics, outages, ticket). */
async function mayJoinChannel(req, kind) {
  const needed = CHANNEL_PERMISSIONS[kind];
  if (!needed) return false;
  for (const slug of needed) {
    if (!await userHasPermission(req, slug)) return false;
  }
  return true;
}

/**
 * True when the principal is bound to a reseller in `orgId`
 * (reseller_user_bindings). A bound account works only in the reseller app:
 * the HTTP fence (middleware/resellerFence.js) refuses it the rest of the v1
 * API, and the real-time feeds carry organization-wide events, so it gets
 * none. A validated global-access principal (never an API token) is not
 * confined. Skipped, like the fence, when the database module has no
 * tenant-context primitive (query-only test doubles).
 */
async function resellerBound({ userId, orgId, apiTokenId, hasGlobalOrganizationAccess }) {
  // Required lazily, so loading this module does not load the reseller services.
  const resellerScope = require('../middleware/resellerScope');
  if (!userId || !orgId || !resellerScope.requestBindingChecksAvailable()) return false;
  if (hasGlobalOrganizationAccess && !apiTokenId) return false;
  return Boolean(await resellerScope.lookupBinding(userId, orgId));
}

/**
 * True when the principal is a carrier (the seeded 'carrier' user group,
 * services/carrierAccount.js). A carrier works only in the carrier app: the
 * HTTP fence refuses it the rest of the v1 API, and the real-time feeds carry
 * organization-wide events, so it gets none. `groupId` is the user's
 * users.group_id when the caller has the row; without it the user is looked
 * up. Skipped like resellerBound for query-only test doubles.
 */
async function carrierAccount({ userId, groupId, apiTokenId, hasGlobalOrganizationAccess }) {
  const resellerScope = require('../middleware/resellerScope');
  const carriers = require('./carrierAccount');
  if (!userId || !resellerScope.requestBindingChecksAvailable()) return false;
  if (hasGlobalOrganizationAccess && !apiTokenId) return false;
  if (groupId === null) return false;
  if (groupId !== undefined) return carriers.isCarrierGroup(groupId);
  return carriers.isCarrierUser(userId);
}

/**
 * Is the principal behind a long-lived subscription still allowed in?
 * Users must still be active with the same token version; API tokens must
 * still be unrevoked and unexpired. With `orgId`, a principal that has since
 * been bound to a reseller in that organization is out too.
 */
async function stillAuthorized({ userId, tokenVersion, apiTokenId, orgId, hasGlobalOrganizationAccess }) {
  if (apiTokenId) {
    const [rows] = await db.query(
      'SELECT id FROM api_tokens WHERE id = ? AND revoked_at IS NULL AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())',
      [apiTokenId],
    );
    if (!rows.length) return false;
  }
  const [rows] = await db.query(
    'SELECT status, token_version FROM users WHERE id = ? AND deleted_at IS NULL',
    [userId],
  );
  const user = rows[0];
  if (!user || user.status !== 'active') return false;
  if (!apiTokenId && tokenVersionStale(tokenVersion, user.token_version)) return false;
  if (orgId && await resellerBound({ userId, orgId, apiTokenId, hasGlobalOrganizationAccess })) return false;
  // A user moved into the carrier group since the stream opened is out too.
  if (await carrierAccount({ userId, apiTokenId, hasGlobalOrganizationAccess })) return false;
  return true;
}

module.exports = {
  EVENT_PERMISSIONS, CHANNEL_PERMISSIONS, REVALIDATE_MS,
  eventPermission, resolveGrants, mayReceive, mayJoinChannel, stillAuthorized, resellerBound, carrierAccount,
};
