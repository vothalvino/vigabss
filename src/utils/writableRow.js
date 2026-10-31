// =============================================================================
// VigaBSS 5.0 — writableRow: tenant writes never touch installation-shared rows
// =============================================================================
// Network inventory tables (ONU profiles, fiber routes, ODF frames/ports, OLT
// ports, splitters, …) treat organization_id NULL rows as installation-shared:
// every tenant may read them. Their write lookups used the same predicate, and
// the UPDATE/DELETE that followed matched by id alone, so any tenant could
// edit or delete a row every other tenant relies on (DB-15). This lookup
// answers 404 for another tenant's row and 403 for a shared one. The null-safe
// `<=>` still lets a caller with no organization (single-tenant install)
// manage its own NULL-org rows; the write itself must also bind
// `organization_id <=> ?`.
// =============================================================================

const db = require('../config/database');

const SAFE_TABLE = /^[a-z_][a-z0-9_]*$/;
const SAFE_COLUMNS = /^[a-z_*][a-z0-9_*, ]*$/;

/**
 * @param {import('express').Response} res
 * @param {string} table     trusted literal table name
 * @param {number|string} id
 * @param {number|null} orgId
 * @param {string} [columns] trusted literal column list
 * @returns {Promise<object|null>} the row, or null after answering 404/403
 */
async function writableRow(res, table, id, orgId, columns = 'id') {
  if (!SAFE_TABLE.test(table) || !SAFE_COLUMNS.test(columns)) throw new Error('writableRow: unsafe identifier');
  const [rows] = await db.query(
    `SELECT ${columns}, organization_id FROM ${table} WHERE id = ? AND (organization_id = ? OR organization_id IS NULL) AND deleted_at IS NULL`,
    [id, orgId],
  );
  if (!rows.length) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  if (rows[0].organization_id === null && orgId !== null && orgId !== undefined) {
    res.status(403).json({ error: 'Shared records are read-only' });
    return null;
  }
  return rows[0];
}

module.exports = { writableRow };
