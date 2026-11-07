// =============================================================================
// VigaBSS 5.0 — Carrier accounts (reseller app, phase 3)
// =============================================================================
// A carrier is a staff user whose user group (users.group_id) is the seeded
// system group 'carrier' (migration 005). It picks up the cash bags resellers
// fill and drops off empty ones, in the carrier app (/carrier-app, the SPA's
// /ruta), and nothing else: middleware/resellerFence.js refuses it every other
// v1 path whatever its group later holds, and the real-time feeds refuse it
// (services/realtimeAccess.js).
//
// Staff identities and groups live in the primary database. authenticate()
// carries the user's group id on req.user (non-enumerable groupId), so a user
// without a group costs no lookup; a validated global-access principal (never
// an API token) is never a carrier.
// =============================================================================

const db = require('../config/database');
const { runInPrimaryContext } = require('../utils/primaryContext');

const CARRIER_GROUP_NAME = 'carrier';

const CARRIER = Symbol('carrierAccount');

// Whether a group id is the carrier group, per process for a minute: the
// fence asks on every staff request. A system group's name and flag cannot
// be edited (routes/roles.js) and a custom group cannot take the name, so a
// short cache only delays seeing the group deleted.
const GROUP_CACHE_MS = 60 * 1000;
const groupCache = new Map();

/** True when the group id is the live system carrier group. */
async function isCarrierGroup(groupId) {
  const id = Number(groupId);
  if (!Number.isInteger(id) || id < 1) return false;
  const cached = groupCache.get(id);
  if (cached && cached.until > Date.now()) return cached.value;
  const [rows] = await runInPrimaryContext(() => db.query(
    'SELECT name, is_system FROM roles WHERE id = ? AND deleted_at IS NULL LIMIT 1',
    [id],
  ));
  const row = rows && rows[0];
  const value = Boolean(row && row.name === CARRIER_GROUP_NAME && Number(row.is_system) === 1);
  if (groupCache.size > 1000) groupCache.clear();
  groupCache.set(id, { value, until: Date.now() + GROUP_CACHE_MS });
  return value;
}

/** Forget the cached group answers (tests, and a group change in this process). */
function clearCarrierGroupCache() {
  groupCache.clear();
}

/**
 * True when the user (by id) is a live account in the carrier group. Used
 * where only an id is at hand: binding a user to a reseller, the real-time
 * re-checks.
 */
async function isCarrierUser(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id < 1) return false;
  const [rows] = await runInPrimaryContext(() => db.query(
    `/* org-scoped by: a staff identity is install-wide; the caller checks the user belongs to its organization */
     SELECT g.name AS group_name
       FROM users u
       JOIN roles g ON g.id = u.group_id AND g.deleted_at IS NULL AND g.is_system = 1
      WHERE u.id = ? AND u.deleted_at IS NULL
      LIMIT 1`,
    [id],
  ));
  return Boolean(rows && rows[0] && rows[0].group_name === CARRIER_GROUP_NAME);
}

/**
 * Is the request's principal a carrier? Memoized on the request. Reads the
 * group id authenticate() put on req.user; none (or an unknown principal
 * shape) is not a carrier.
 */
async function isCarrierRequest(req) {
  if (!req || !req.user) return false;
  if (req.user.hasGlobalOrganizationAccess && !req.user.apiTokenId) return false;
  const groupId = req.user.groupId;
  if (groupId === null || groupId === undefined) return false;
  const key = `${req.user.id}:${groupId}`;
  if (req[CARRIER] && req[CARRIER].key === key) return req[CARRIER].value;
  const value = await isCarrierGroup(groupId);
  req[CARRIER] = { key, value };
  return value;
}

/** The id of the live system carrier group, or null. */
async function carrierGroupId() {
  const [rows] = await runInPrimaryContext(() => db.query(
    "SELECT id FROM roles WHERE name = 'carrier' AND is_system = 1 AND deleted_at IS NULL LIMIT 1",
  ));
  return rows && rows[0] ? Number(rows[0].id) : null;
}

/** Attach the group id to an authenticated principal without changing its shape. */
function attachGroupId(user, groupId) {
  Object.defineProperty(user, 'groupId', {
    value: groupId === undefined ? null : groupId,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return user;
}

module.exports = {
  CARRIER_GROUP_NAME,
  isCarrierGroup,
  isCarrierUser,
  isCarrierRequest,
  carrierGroupId,
  attachGroupId,
  clearCarrierGroupCache,
};
