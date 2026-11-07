// =============================================================================
// VigaBSS 5.0 — reseller names on staff rows
// =============================================================================
// Leads (migration 003) and payments (migration 004) carry reseller_id: the
// reseller that captured the lead or collected the payment. Staff lists and
// details add its name. The lookup binds the reseller to the row's
// organization, so a foreign id can never surface another tenant's name.
// =============================================================================

const db = require('../config/database');
const { inPlaceholders } = require('./sqlBuild');
const { requireOrgId } = require('./requireOrgId');

/** Set row.reseller_name on each row (or the one row) that has a reseller_id key. */
async function addResellerNames(data, orgId) {
  const rows = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
  const ids = [...new Set(rows.map((r) => r.reseller_id).filter((id) => id !== null && id !== undefined).map(Number))];
  const names = new Map();
  if (ids.length) {
    requireOrgId(orgId, 'addResellerNames');
    const [found] = await db.query(
      /* includes deleted rows: a row keeps the name of the reseller that captured or collected it */
      `SELECT id, name FROM resellers WHERE organization_id = ? AND id IN (${inPlaceholders(ids)})`,
      [orgId, ...ids],
    );
    for (const r of found) names.set(Number(r.id), r.name);
  }
  for (const row of rows) {
    if (!('reseller_id' in row)) continue;
    row.reseller_name = row.reseller_id === null || row.reseller_id === undefined
      ? null
      : names.get(Number(row.reseller_id)) ?? null;
  }
}

/** Run a crudController handler and add reseller names to the `data` it sends. */
function withResellerNames(handler) {
  return (req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body) => {
      res.json = send;
      if (res.statusCode >= 400 || !body || body.data === undefined) return send(body);
      addResellerNames(body.data, req.orgId).then(() => send(body), next);
      return res;
    };
    return handler(req, res, next);
  };
}

module.exports = { addResellerNames, withResellerNames };
