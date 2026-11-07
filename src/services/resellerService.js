// =============================================================================
// VigaBSS 5.0 — Reseller Service (§19)
// =============================================================================
// Business logic for the multi-level reseller hierarchy:
//   - getResellerSubtree  — resolve all reseller IDs in a subtree (for scoping)
//   - getResellerClientIds — all client IDs belonging to a reseller subtree
//   - getResellerDashboard — §19.3 aggregate stats for a reseller
//   - syncResellerCommission — the commission engine (resellerCommissionService)
//
// Reseller scoping is a product-feature ownership filter (like organization_id).
// It is NOT a hard multi-tenant security isolation layer.
// =============================================================================

const db = require('../config/database');
const { businessToday, businessDayStartUtc } = require('../utils/businessDate');
const money = require('../utils/money');
const { inPlaceholders } = require('../utils/sqlBuild');

/**
 * Returns the flat list of reseller IDs that are in the subtree rooted at
 * resellerIds (inclusive of the root ids). Depth is limited to 2 (Master + Sub).
 *
 * @param {number[]} rootIds - array of reseller IDs to start from
 * @param {number}   orgId   - organization scope
 * @returns {Promise<number[]>}
 */
async function getResellerSubtree(rootIds, orgId) {
  if (!rootIds || rootIds.length === 0) return [];

  // db.query() is execute()-backed: `IN (?)` does NOT expand an array bind
  // (silently returns wrong/empty rows on real MySQL — DB-mocked jest can't
  // see it). Expand placeholders explicitly and spread the ids. See
  // sqlBuild.inPlaceholders for the full story.
  const [children] = await db.query(
    `SELECT id FROM resellers
     WHERE organization_id = ? AND parent_id IN (${inPlaceholders(rootIds)}) AND deleted_at IS NULL`,
    [orgId, ...rootIds],
  );

  const childIds = children.map((r) => r.id);
  return [...rootIds, ...childIds];
}

/**
 * Returns all client IDs belonging to the reseller subtree.
 *
 * @param {number[]} resellerIds - flat subtree of reseller IDs
 * @param {number}   orgId
 * @returns {Promise<number[]>}
 */
async function getResellerClientIds(resellerIds, orgId) {
  if (!resellerIds || resellerIds.length === 0) return [];

  const [rows] = await db.query(
    `SELECT id FROM clients
     WHERE organization_id = ? AND reseller_id IN (${inPlaceholders(resellerIds)}) AND deleted_at IS NULL`,
    [orgId, ...resellerIds],
  );
  return rows.map((r) => r.id);
}

/**
 * Dashboard aggregates for a reseller (§19.3), over its subtree:
 *   - subscriber_count   : active clients
 *   - total_revenue      : total of its clients' invoices paid this business
 *                          month (by paid_at, organization time zone)
 *   - open_tickets       : open tickets on their clients
 *   - pending_commission : commission earned this business month on its
 *                          clients' invoices and still standing (phase 4; the
 *                          name is kept for the response shape). Commissions
 *                          are booked on the top-level reseller, so a
 *                          sub-reseller's figure is the part of its parent's
 *                          that its own clients earned.
 *
 * @param {number} resellerId
 * @param {number} orgId
 * @returns {Promise<object>}
 */
async function getResellerDashboard(resellerId, orgId) {
  // Resolve subtree
  const subtree = await getResellerSubtree([resellerId], orgId);
  const clientIds = await getResellerClientIds(subtree, orgId);

  const result = {
    reseller_id: resellerId,
    subscriber_count: 0,
    total_revenue: 0,
    open_tickets: 0,
    pending_commission: 0,
  };

  if (clientIds.length === 0) return result;

  const idsIn = inPlaceholders(clientIds);
  const monthStart = businessDayStartUtc(`${businessToday().slice(0, 7)}-01`);

  const [[subRow]] = await db.query(
    `SELECT COUNT(*) AS cnt FROM clients
      WHERE organization_id = ? AND id IN (${idsIn}) AND status = ? AND deleted_at IS NULL`,
    [orgId, ...clientIds, 'active'],
  );
  result.subscriber_count = Number(subRow.cnt) || 0;

  const [[revRow]] = await db.query(
    `SELECT COALESCE(SUM(total), 0) AS rev
     FROM invoices
     WHERE organization_id = ? AND client_id IN (${idsIn})
       AND deleted_at IS NULL
       AND status = 'paid'
       AND paid_at >= ?`,
    [orgId, ...clientIds, monthStart],
  );
  result.total_revenue = money.round(revRow.rev || 0);

  const [[tickRow]] = await db.query(
    `SELECT COUNT(*) AS cnt FROM tickets
     WHERE organization_id = ? AND client_id IN (${idsIn}) AND status NOT IN ('resolved','closed') AND deleted_at IS NULL`,
    [orgId, ...clientIds],
  );
  result.open_tickets = Number(tickRow.cnt) || 0;

  const [[commRow]] = await db.query(
    `SELECT COALESCE(SUM(commission_amount), 0) AS total
     FROM reseller_commissions
     WHERE organization_id = ? AND client_id IN (${idsIn})
       AND status = 'earned' AND reversed_at IS NULL AND earned_at >= ?`,
    [orgId, ...clientIds, monthStart],
  );
  result.pending_commission = money.round(commRow.total || 0);

  return result;
}

module.exports = {
  getResellerSubtree,
  getResellerClientIds,
  getResellerDashboard,
  // The commission engine (phase 4) replaced recordCommission, which nothing
  // called; see resellerCommissionService.js.
  syncResellerCommission: (...args) => require('./resellerCommissionService').syncResellerCommission(...args),
};
