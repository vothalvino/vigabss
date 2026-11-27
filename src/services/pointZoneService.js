// =============================================================================
// VigaBSS 5.0 — Zones of resellers and collectors (migration 041)
// =============================================================================
// A zone is an id and a name. A point (a top-level reseller or a collector)
// is in one zone or in none. The cash bags page totals and filters by zone.
// =============================================================================

const db = require('../config/database');
const { AppError, NotFoundError, ValidationError } = require('../utils/errors');

function cleanName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new ValidationError('name is required');
  if (name.length > 100) throw new ValidationError('name is at most 100 characters');
  return name;
}
const duplicate = (err) => (err && err.code === 'ER_DUP_ENTRY'
  ? new AppError('A zone with that name already exists.', 409, 'ZONE_EXISTS') : err);

/** The organization's zones with how many points each has, by name. */
async function list(orgId) {
  const [rows] = await db.query(
    `SELECT z.id, z.name,
            (SELECT COUNT(*) FROM resellers r
              WHERE r.zone_id = z.id AND r.organization_id = z.organization_id AND r.deleted_at IS NULL) AS points
       FROM point_zones z
      WHERE z.organization_id = ? AND z.deleted_at IS NULL
      ORDER BY z.name, z.id`,
    [orgId],
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name, points: Number(r.points) }));
}

async function zoneOr404(orgId, id) {
  const [rows] = await db.query(
    'SELECT id, name FROM point_zones WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [id, orgId],
  );
  if (!rows[0]) throw new NotFoundError('Zone');
  return { id: Number(rows[0].id), name: rows[0].name };
}

async function create(orgId, userId, body) {
  const name = cleanName(body.name);
  try {
    const [result] = await db.query(
      'INSERT INTO point_zones (organization_id, name, created_by) VALUES (?, ?, ?)',
      [orgId, name, userId],
    );
    return { id: result.insertId, name, points: 0 };
  } catch (err) { throw duplicate(err); }
}

async function rename(orgId, id, body) {
  await zoneOr404(orgId, id);
  const name = cleanName(body.name);
  try {
    await db.query(
      'UPDATE point_zones SET name = ? WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [name, id, orgId],
    );
  } catch (err) { throw duplicate(err); }
  return zoneOr404(orgId, id);
}

/** Remove a zone. Its points are left with no zone. */
async function remove(orgId, id) {
  const zone = await zoneOr404(orgId, id);
  await db.query(
    'UPDATE resellers SET zone_id = NULL WHERE zone_id = ? AND organization_id = ? /* includes deleted rows: a removed point must not keep a removed zone */',
    [id, orgId],
  );
  await db.query(
    'UPDATE point_zones SET deleted_at = NOW() WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [id, orgId],
  );
  return zone;
}

/** The points a zone can be given to: top-level resellers and collectors, with their zone. */
async function points(orgId) {
  const [rows] = await db.query(
    `SELECT r.id, r.name, r.kind, r.city, r.status, r.zone_id
       FROM resellers r
      WHERE r.organization_id = ? AND r.deleted_at IS NULL AND r.parent_id IS NULL
      ORDER BY r.name, r.id LIMIT 1000`,
    [orgId],
  );
  return rows.map((r) => ({
    id: Number(r.id), name: r.name, kind: r.kind, city: r.city, status: r.status,
    zone_id: r.zone_id === null ? null : Number(r.zone_id),
  }));
}

/** Put a point in a zone, or in none (zoneId null). Both must be this organization's. */
async function assign(orgId, resellerId, zoneId) {
  const [found] = await db.query(
    'SELECT id FROM resellers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [resellerId, orgId],
  );
  if (!found[0]) throw new NotFoundError('Reseller');
  if (zoneId !== null) await zoneOr404(orgId, zoneId);
  await db.query(
    'UPDATE resellers SET zone_id = ? WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [zoneId, resellerId, orgId],
  );
  return { reseller_id: Number(resellerId), zone_id: zoneId };
}

module.exports = { list, create, rename, remove, points, assign };
