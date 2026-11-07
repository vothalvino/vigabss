// =============================================================================
// VigaBSS 5.0 — Carriers and their resellers (reseller app, phase 3)
// =============================================================================
// A carrier account (services/carrierAccount.js) visits the top-level
// resellers an administrator assigned to it (carrier_reseller_assignments),
// drops off empty cash bags and picks up sealed ones. It sees only those
// resellers, and of them only what a route needs: name, address, phone,
// coordinates and bag counts, never money, clients or the ledger.
//
// Staff identities live in the primary database; assignments and bags live
// beside `resellers`, in the organization's own database when it is isolated.
// =============================================================================

const db = require('../config/database');
const { requireOrgId } = require('../utils/requireOrgId');
const { inPlaceholders } = require('../utils/sqlBuild');
const { runInPrimaryContext } = require('../utils/primaryContext');

const toNumberOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const fullName = (u) => (u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || null : null);

/**
 * The carrier with this user id visible in the organization (homed in it or
 * a member of it), or null: { id, first_name, last_name, email, phone, status }.
 */
async function findCarrier(orgId, userId) {
  requireOrgId(orgId, 'carrierService.findCarrier');
  const id = Number(userId);
  if (!Number.isInteger(id) || id < 1) return null;
  const [rows] = await runInPrimaryContext(() => db.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.status
       FROM users u
       JOIN roles g ON g.id = u.group_id AND g.name = 'carrier' AND g.is_system = 1 AND g.deleted_at IS NULL
      WHERE u.id = ? AND u.deleted_at IS NULL
        AND (u.organization_id = ? OR EXISTS (
              SELECT 1 FROM organization_users ou
               WHERE ou.user_id = u.id AND ou.organization_id = ? AND ou.deleted_at IS NULL))
      LIMIT 1`,
    [id, orgId, orgId],
  ));
  return rows && rows[0] ? rows[0] : null;
}

/** Every carrier visible in the organization, by name. */
async function listCarrierUsers(orgId) {
  requireOrgId(orgId, 'carrierService.listCarrierUsers');
  const [rows] = await runInPrimaryContext(() => db.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.status
       FROM users u
       JOIN roles g ON g.id = u.group_id AND g.name = 'carrier' AND g.is_system = 1 AND g.deleted_at IS NULL
      WHERE u.deleted_at IS NULL
        AND (u.organization_id = ? OR EXISTS (
              SELECT 1 FROM organization_users ou
               WHERE ou.user_id = u.id AND ou.organization_id = ? AND ou.deleted_at IS NULL))
      ORDER BY u.first_name ASC, u.last_name ASC, u.id ASC
      LIMIT 500`,
    [orgId, orgId],
  ));
  return rows || [];
}

/** Display names of staff users by id, as Map(id → "First Last"). Archived users keep their name. */
async function userNames(ids) {
  const list = [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map();
  if (!list.length) return out;
  const [rows] = await runInPrimaryContext(() => db.query(
    `/* includes deleted rows: a bag's history keeps naming an archived carrier or staff member */
     /* org-scoped by: the ids come from cash bag rows already bound to the organization; staff identities live in the primary database */
     SELECT id, first_name, last_name FROM users WHERE id IN (${inPlaceholders(list)})`,
    list,
  ));
  for (const u of rows || []) out.set(Number(u.id), fullName(u));
  return out;
}

/** Reseller ids assigned to the carrier in the organization (live top-level resellers only). */
async function assignedResellers(orgId, carrierUserId) {
  requireOrgId(orgId, 'carrierService.assignedResellers');
  const [rows] = await db.query(
    `SELECT r.id, r.name, r.address, r.city, r.phone, r.latitude, r.longitude
       FROM carrier_reseller_assignments a
       JOIN resellers r ON r.id = a.reseller_id AND r.organization_id = a.organization_id
                       AND r.deleted_at IS NULL AND r.parent_id IS NULL
      WHERE a.organization_id = ? AND a.carrier_user_id = ?
      ORDER BY r.name ASC, r.id ASC`,
    [orgId, carrierUserId],
  );
  return rows || [];
}

/**
 * The reseller if it is assigned to the carrier (and a live top-level reseller
 * of the organization), else null. Callers answer 404 either way.
 */
async function assignedReseller(orgId, carrierUserId, resellerId) {
  requireOrgId(orgId, 'carrierService.assignedReseller');
  const id = Number(resellerId);
  if (!Number.isInteger(id) || id < 1) return null;
  const [rows] = await db.query(
    `SELECT r.id, r.name
       FROM carrier_reseller_assignments a
       JOIN resellers r ON r.id = a.reseller_id AND r.organization_id = a.organization_id
                       AND r.deleted_at IS NULL AND r.parent_id IS NULL
      WHERE a.organization_id = ? AND a.carrier_user_id = ? AND a.reseller_id = ?
      LIMIT 1`,
    [orgId, carrierUserId, id],
  );
  return rows && rows[0] ? rows[0] : null;
}

/** Assigned resellers of several carriers: Map(carrierUserId → [{ id, name }]). */
async function assignmentsFor(orgId, carrierUserIds) {
  requireOrgId(orgId, 'carrierService.assignmentsFor');
  const ids = [...new Set((carrierUserIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT a.carrier_user_id, r.id, r.name
       FROM carrier_reseller_assignments a
       JOIN resellers r ON r.id = a.reseller_id AND r.organization_id = a.organization_id
                       AND r.deleted_at IS NULL AND r.parent_id IS NULL
      WHERE a.organization_id = ? AND a.carrier_user_id IN (${inPlaceholders(ids)})
      ORDER BY r.name ASC, r.id ASC`,
    [orgId, ...ids],
  );
  for (const r of rows || []) {
    const list = out.get(Number(r.carrier_user_id));
    if (list) list.push({ id: Number(r.id), name: r.name });
  }
  return out;
}

/** Bags in each carrier's hands: Map(carrierUserId → { with_carrier, in_transit }). */
async function bagsInHandFor(orgId, carrierUserIds) {
  requireOrgId(orgId, 'carrierService.bagsInHandFor');
  const ids = [...new Set((carrierUserIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map(ids.map((id) => [id, { with_carrier: 0, in_transit: 0 }]));
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT carrier_user_id,
            COALESCE(SUM(status = 'with_carrier'), 0) AS with_carrier,
            COALESCE(SUM(status = 'in_transit'), 0) AS in_transit
       FROM cash_bags
      WHERE organization_id = ? AND carrier_user_id IN (${inPlaceholders(ids)}) AND deleted_at IS NULL
        AND status IN ('with_carrier', 'in_transit')
      GROUP BY carrier_user_id`,
    [orgId, ...ids],
  );
  for (const r of rows || []) {
    out.set(Number(r.carrier_user_id), { with_carrier: Number(r.with_carrier) || 0, in_transit: Number(r.in_transit) || 0 });
  }
  return out;
}

/**
 * Replace the carrier's assigned resellers in one transaction. Every id must
 * be a live top-level reseller of the organization (422 otherwise).
 * @returns {Promise<{ before: number[], after: number[] }>}
 */
async function setAssignments(orgId, carrierUserId, resellerIds, actorId) {
  requireOrgId(orgId, 'carrierService.setAssignments');
  const ids = [...new Set(resellerIds)];
  if (ids.length) {
    const [found] = await db.query(
      `SELECT id FROM resellers
        WHERE organization_id = ? AND deleted_at IS NULL AND parent_id IS NULL AND id IN (${inPlaceholders(ids)})`,
      [orgId, ...ids],
    );
    const known = new Set((found || []).map((r) => Number(r.id)));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) {
      const { ValidationError } = require('../utils/errors');
      throw new ValidationError(`reseller_ids: not a top-level reseller of this organization: ${missing.join(', ')}`);
    }
  }
  const conn = await db.getConnection();
  const exec = conn.execute.bind(conn);
  let before;
  try {
    await conn.beginTransaction();
    const [current] = await exec(
      'SELECT reseller_id FROM carrier_reseller_assignments WHERE organization_id = ? AND carrier_user_id = ? FOR UPDATE',
      [orgId, carrierUserId],
    );
    before = (current || []).map((r) => Number(r.reseller_id)).sort((a, b) => a - b);
    await exec(
      'DELETE FROM carrier_reseller_assignments WHERE organization_id = ? AND carrier_user_id = ?',
      [orgId, carrierUserId],
    );
    if (ids.length) {
      await exec(
        `INSERT INTO carrier_reseller_assignments (organization_id, carrier_user_id, reseller_id, created_by)
         VALUES ${ids.map(() => '(?, ?, ?, ?)').join(', ')}`,
        ids.flatMap((id) => [orgId, carrierUserId, id, actorId]),
      );
    }
    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch (_rollbackErr) { /* keep the original error */ }
    throw err;
  } finally {
    conn.release();
  }
  return { before, after: [...ids].sort((a, b) => a - b) };
}

// The most resellers the assignment picker lists (one carrier may be given
// at most 500: PUT /carriers/:userId/resellers).
const MAX_ASSIGNABLE = 2000;

/**
 * The live top-level resellers of the organization that a carrier may be
 * assigned, by name: [{ id, name, city }], at most MAX_ASSIGNABLE, with the
 * total so the page can say when the list is cut. Guarded by carriers.manage
 * alone, so assigning does not need resellers.view, and unpaged (the staff
 * reseller list caps a page at 100).
 */
async function assignableResellers(orgId) {
  requireOrgId(orgId, 'carrierService.assignableResellers');
  const [rows] = await db.query(
    `SELECT id, name, city FROM resellers
      WHERE organization_id = ? AND deleted_at IS NULL AND parent_id IS NULL
      ORDER BY name ASC, id ASC
      LIMIT ${MAX_ASSIGNABLE}`,
    [orgId],
  );
  const [[count]] = await db.query(
    'SELECT COUNT(*) AS total FROM resellers WHERE organization_id = ? AND deleted_at IS NULL AND parent_id IS NULL',
    [orgId],
  );
  return {
    rows: (rows || []).map((r) => ({ id: Number(r.id), name: r.name, city: r.city ?? null })),
    total: Number(count?.total) || 0,
  };
}

/** The carrier's assigned resellers as the staff page shows them. */
async function assignmentRows(orgId, carrierUserId) {
  const rows = await assignedResellers(orgId, carrierUserId);
  return rows.map((r) => ({ id: Number(r.id), name: r.name, city: r.city ?? null, phone: r.phone ?? null }));
}

module.exports = {
  MAX_ASSIGNABLE,
  assignableResellers,
  findCarrier,
  listCarrierUsers,
  userNames,
  assignedResellers,
  assignedReseller,
  assignmentsFor,
  bagsInHandFor,
  setAssignments,
  assignmentRows,
  fullName,
  toNumberOrNull,
};
