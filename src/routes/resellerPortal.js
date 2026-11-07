// =============================================================================
// VigaBSS 5.0 — Reseller Portal Routes (§19.3)
// =============================================================================
//
//  §19.3 Reseller Portal (admin-side endpoints; reseller_admin role consumes)
//  GET    /reseller-portal/:id/dashboard       aggregate stats for reseller
//  GET    /reseller-portal/:id/clients         list clients scoped to reseller
//  GET    /reseller-portal/:id/invoices        list invoices for reseller clients
//  GET    /reseller-portal/:id/inventory       list inventory scoped to reseller
//
//  Every :id must be inside the caller's reseller scope (TNB-13): a user bound
//  to a reseller (reseller_user_bindings) only reaches its own subtree, an
//  unbound reseller_admin is refused, and org-level staff keep access to every
//  reseller in their organization. See middleware/resellerScope.js.
//
//  A reseller does not create, suspend or cancel customers: it signs them up
//  as leads in the reseller app (routes/resellerApp.js), and the ISP converts
//  and manages them.
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { resellerScope, assertResellerInScope } = require('../middleware/resellerScope');
const { NotFoundError } = require('../utils/errors');
const db = require('../config/database');
const resellerService = require('../services/resellerService');
const { inPlaceholders } = require('../utils/sqlBuild');

const router = Router();
router.use(authenticate);
router.use(orgScope);
router.use(resellerScope);

// ---------------------------------------------------------------------------
// Helper — verify the URL reseller is in the caller's scope and current org.
// Out-of-scope and foreign ids both 404, so a bound user cannot probe ids.
// ---------------------------------------------------------------------------
async function getResellerOrThrow(req) {
  assertResellerInScope(req, req.params.id);
  const [[row]] = await db.query(
    'SELECT * FROM resellers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [req.params.id, req.orgId],
  );
  if (!row) throw new NotFoundError('Reseller');
  return row;
}

// A reseller is a third party: these routes return named columns only, never
// a whole row. clients carries the subscriber-portal password and reset
// hashes, the CURP and the ISP's notes; invoices and asset assignments carry
// internal notes.
const CLIENT_COLUMNS = [
  'id', 'name', 'phone', 'email', 'status', 'reseller_id', 'address', 'city', 'created_at',
].join(', ');
const INVOICE_COLUMNS = [
  'i.id', 'i.client_id', 'i.contract_id', 'i.invoice_number', 'i.issue_date', 'i.due_date',
  'i.subtotal', 'i.tax_amount', 'i.total', 'i.currency', 'i.status', 'i.paid_at',
].join(', ');

// =============================================================================
// Dashboard (§19.3)
// =============================================================================

// GET /reseller-portal/:id/dashboard
router.get('/:id/dashboard', requirePermission('reseller_portal.dashboard'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const dashboard = await resellerService.getResellerDashboard(
      parseInt(req.params.id, 10), req.orgId,
    );
    res.json({ data: dashboard });
  } catch (err) { next(err); }
});

// =============================================================================
// Customer Management (§19.3)
// =============================================================================

// GET /reseller-portal/:id/clients
router.get('/:id/clients', requirePermission('reseller_portal.manage_customers'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const { page = 1, limit = 50, status } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
    const offset = (pageNum - 1) * limitNum;

    const subtree = await resellerService.getResellerSubtree(
      [parseInt(req.params.id, 10)], req.orgId,
    );

    // db.query() is execute()-backed: `IN (?)` does NOT expand an array bind
    // (silently returns wrong/empty rows on real MySQL — DB-mocked jest can't
    // see it). Expand placeholders explicitly and spread the ids. See
    // sqlBuild.inPlaceholders for the full story.
    const conditions = [`organization_id = ? AND reseller_id IN (${inPlaceholders(subtree)}) AND deleted_at IS NULL`];
    const params = [req.orgId, ...subtree];
    if (status) { conditions.push('status = ?'); params.push(status); }

    const where = conditions.join(' AND ');
    const [rows] = await db.query(
      `SELECT ${CLIENT_COLUMNS} FROM clients WHERE ${where} ORDER BY name ASC LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM clients WHERE ${where}`, params,
    );
    res.json({ data: rows, meta: { total, page: pageNum, limit: limitNum } });
  } catch (err) { next(err); }
});

// =============================================================================
// Invoices (§19.3 — branded invoice list)
// =============================================================================

// GET /reseller-portal/:id/invoices
router.get('/:id/invoices', requirePermission('reseller_portal.invoices'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const { page = 1, limit = 50, status } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
    const offset = (pageNum - 1) * limitNum;

    const subtree = await resellerService.getResellerSubtree(
      [parseInt(req.params.id, 10)], req.orgId,
    );
    const clientIds = await resellerService.getResellerClientIds(subtree, req.orgId);

    if (clientIds.length === 0) {
      return res.json({ data: [], meta: { total: 0, page: pageNum, limit: limitNum } });
    }

    const conditions = [`i.organization_id = ? AND i.client_id IN (${inPlaceholders(clientIds)})`, 'i.deleted_at IS NULL'];
    const params = [req.orgId, ...clientIds];
    if (status) { conditions.push('i.status = ?'); params.push(status); }

    const where = conditions.join(' AND ');
    const [rows] = await db.query(
      `SELECT ${INVOICE_COLUMNS}, c.name AS client_name
       FROM invoices i
       LEFT JOIN clients c ON i.client_id = c.id AND c.organization_id = i.organization_id
       WHERE ${where} ORDER BY i.issue_date DESC LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM invoices i WHERE ${where}`, params,
    );
    res.json({ data: rows, meta: { total, page: pageNum, limit: limitNum } });
  } catch (err) { next(err); }
});

// =============================================================================
// Inventory (§19.3 — reseller-assigned equipment from §14 inventory)
// =============================================================================

// GET /reseller-portal/:id/inventory
router.get('/:id/inventory', requirePermission('reseller_portal.inventory'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    // Reuse §14 inventory: assets assigned to clients that belong to this reseller
    const subtree = await resellerService.getResellerSubtree(
      [parseInt(req.params.id, 10)], req.orgId,
    );
    const clientIds = await resellerService.getResellerClientIds(subtree, req.orgId);
    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
    const offset = (pageNum - 1) * limitNum;

    if (clientIds.length === 0) {
      return res.json({ data: [], meta: { total: 0, page: pageNum, limit: limitNum } });
    }

    const idsIn = inPlaceholders(clientIds);
    const [rows] = await db.query(
      `SELECT aa.id, aa.asset_id, aa.client_id, aa.assigned_at, a.name AS asset_name, a.serial_number, a.model, a.manufacturer,
              c.name AS client_name
       FROM asset_assignments aa
       JOIN assets a ON aa.asset_id = a.id
       LEFT JOIN clients c ON aa.client_id = c.id
       WHERE aa.client_id IN (${idsIn}) AND aa.returned_at IS NULL
       ORDER BY aa.assigned_at DESC LIMIT ${limitNum} OFFSET ${offset}`,
      [...clientIds],
    );
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM asset_assignments aa WHERE aa.client_id IN (${idsIn}) AND aa.returned_at IS NULL`,
      [...clientIds],
    );
    res.json({ data: rows, meta: { total, page: pageNum, limit: limitNum } });
  } catch (err) { next(err); }
});

module.exports = router;
