// =============================================================================
// VigaBSS 5.0 — assertOwnedReferences
// =============================================================================
// A tenant-owned row that references another tenant-owned row must verify that
// reference against the caller's organization. The database foreign keys only
// prove the referenced row EXISTS, not that it belongs to anyone in particular:
// an org-agnostic FK cannot express tenancy. Without this check, org A could
// store org B's client/device/warehouse id on an org-A row, and every display
// join or side effect keyed on that id would then read or mutate org B's data.
//
// Ownership is not a shape, so this runs after validate() rather than in it.
// A foreign or missing reference is rejected with a 422 ValidationError
// (ARCHITECTURE.md, "Database tenant routing").
//
// Rules:
//   - Only fields actually present in `body` with a non-null value are checked
//     (PATCH-safe; an explicit null clears a link and needs no check).
//   - The referenced row must be live (deleted_at IS NULL) and its
//     organization_id must match null-safely (`<=>`), so a single-tenant
//     install whose rows carry organization_id NULL still works while one
//     tenant can never match another tenant's row.
//   - `allowShared: true` additionally admits organization_id IS NULL rows for
//     modules whose read predicate treats NULL-org rows as installation-shared
//     (for example fiber plant inventory).
//   - The special table 'users' applies the Users page's organization
//     visibility rule (home org, explicit membership, installation identity).
// =============================================================================

const db = require('../config/database');
const { ValidationError } = require('./errors');
const { requireOrgId } = require('./requireOrgId');

// Tables this helper may be pointed at. An allowlist keeps the interpolated
// table name out of reach of any caller-controlled string.
const OWNED_TABLES = new Set([
  'clients', 'contracts', 'devices', 'tickets', 'client_interactions',
  'sites', 'olt_ports', 'olt_splitters', 'onu_details', 'fiber_routes',
  'odf_frames', 'odf_ports', 'inventory_items', 'warehouses', 'vendors',
  'assets', 'purchase_orders', 'cpe_devices',
]);

function normalizeSpec(spec) {
  return typeof spec === 'string' ? { table: spec } : spec;
}

/**
 * @param {object} body       request body (or any object holding the ids)
 * @param {number|null} orgId the caller's organization (req.orgId)
 * @param {object} refs       { field: 'table' | { table, allowShared? } }
 * @param {object} [opts]
 * @param {Function} [opts.exec] bound query function (e.g. conn.query.bind(conn))
 *   so the check can run on a transaction's connection; defaults to db.query.
 * @param {boolean} [opts.includeDeleted] admit soft-deleted rows (ownership
 *   re-checks on rows that were linked while the target was still live).
 */
async function assertOwnedReferences(body, orgId, refs, opts = {}) {
  requireOrgId(orgId, 'assertOwnedReferences');
  const exec = opts.exec || ((sql, params) => db.query(sql, params));
  for (const [field, rawSpec] of Object.entries(refs)) {
    const value = body?.[field];
    if (value === undefined || value === null || value === '') continue;
    const { table, allowShared = false } = normalizeSpec(rawSpec);

    if (table === 'users') {
      // Lazy require: User pulls in a large model graph.
      const User = require('../models/User');
      const visible = await User.count({ where: { id: value }, orgId });
      if (!Number(visible)) {
        throw new ValidationError(`${field} is not a user of this organization`);
      }
      continue;
    }

    if (!OWNED_TABLES.has(table)) {
      throw new Error(`assertOwnedReferences: table ${table} is not allowlisted`);
    }
    const orgPredicate = allowShared
      ? '(organization_id <=> ? OR organization_id IS NULL)'
      : 'organization_id <=> ?';
    const liveOnly = opts.includeDeleted ? '' : ' AND deleted_at IS NULL';
    const [rows] = await exec(
      `SELECT id FROM ${table} WHERE id = ? AND ${orgPredicate}${liveOnly} LIMIT 1`,
      [value, orgId],
    );
    if (!rows || !rows.length) {
      throw new ValidationError(`${field} does not belong to this organization`);
    }
  }
}

/** Express middleware form: checks req.body against req.orgId. */
function ownedReferences(refs) {
  return async (req, _res, next) => {
    try {
      await assertOwnedReferences(req.body, req.orgId, refs);
      next();
    } catch (err) { next(err); }
  };
}

module.exports = { assertOwnedReferences, ownedReferences, OWNED_TABLES };
