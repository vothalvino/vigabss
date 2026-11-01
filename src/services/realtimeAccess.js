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
 * Is the principal behind a long-lived subscription still allowed in?
 * Users must still be active with the same token version; API tokens must
 * still be unrevoked and unexpired.
 */
async function stillAuthorized({ userId, tokenVersion, apiTokenId }) {
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
  return true;
}

module.exports = {
  EVENT_PERMISSIONS, CHANNEL_PERMISSIONS, REVALIDATE_MS,
  eventPermission, resolveGrants, mayReceive, mayJoinChannel, stillAuthorized,
};
