// =============================================================================
// VigaBSS 5.0 — Reseller Routes (§19.1 + §19.2)
// =============================================================================
//
//  §19.1 Reseller Hierarchy & Pricing
//  GET    /resellers                      list resellers (flat, org-scoped)
//  POST   /resellers                      create reseller
//  GET    /resellers/:id                  get reseller detail
//  PUT    /resellers/:id                  update reseller
//  DELETE /resellers/:id                  soft-delete reseller
//  POST   /resellers/:id/suspend          suspend reseller
//  GET    /resellers/:id/plan-prices       list custom plan prices
//  POST   /resellers/:id/plan-prices       set custom plan price
//  DELETE /resellers/:id/plan-prices/:ppId remove custom plan price
//  GET    /resellers/:id/commissions       list commission records
//  POST   /resellers/:id/commissions/:cId/approve  approve commission
//
//  §19.2 Resource Allocations
//  GET    /resellers/:id/ip-pools          list IP pool allocations
//  POST   /resellers/:id/ip-pools          add IP pool allocation
//  DELETE /resellers/:id/ip-pools/:allocId remove IP pool allocation
//  GET    /resellers/:id/bandwidth-quota   get bandwidth quota
//  PUT    /resellers/:id/bandwidth-quota   set bandwidth quota
//  GET    /resellers/:id/olt-ports         list OLT port assignments
//  POST   /resellers/:id/olt-ports         add OLT port assignment
//  DELETE /resellers/:id/olt-ports/:aId    remove OLT port assignment
//  GET    /resellers/:id/billing-entity    get billing entity
//  PUT    /resellers/:id/billing-entity    upsert billing entity
//
//  User bindings (TNB-13, migration 475)
//  GET    /resellers/:id/users             list users bound to the reseller
//  PUT    /resellers/:id/users/:userId     bind (or re-bind) a user to it
//  DELETE /resellers/:id/users/:userId     remove the user's binding
//
//  Every route is confined to the caller's reseller scope: a bound user only
//  sees its own subtree (404 outside it, GET / filtered), an unbound
//  reseller_admin is refused, and org-level staff see every reseller in their
//  organization. Binding management is org-level only. See
//  middleware/resellerScope.js.
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { resellerScope, assertResellerInScope, resellerInScope } = require('../middleware/resellerScope');
const { ForbiddenError, NotFoundError, ValidationError } = require('../utils/errors');
const Organization = require('../models/Organization');
const User = require('../models/User');
const auditLog = require('../services/auditLog');
const db = require('../config/database');
const { inPlaceholders } = require('../utils/sqlBuild');
const { runInPrimaryContext } = require('../utils/primaryContext');

const router = Router();
router.use(authenticate);
router.use(orgScope);
router.use(resellerScope);

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const createResellerSchema = {
  name:                { type: 'string', required: true, min: 1, max: 255 },
  email:               { type: 'string', max: 255 },
  phone:               { type: 'string', max: 30 },
  contact_name:        { type: 'string', max: 255 },
  parent_id:           { type: 'number' },
  commission_rate:     { type: 'number', min: 0, max: 100 },
  status:              { type: 'string', enum: ['active', 'suspended', 'inactive'] },
  brand_logo_url:      { type: 'string', max: 500 },
  brand_primary_color: { type: 'string', max: 7 },
  brand_accent_color:  { type: 'string', max: 7 },
  portal_domain:       { type: 'string', max: 255 },
  portal_name:         { type: 'string', max: 255 },
  notes:               { type: 'string' },
};

const updateResellerSchema = {
  name:                { type: 'string', min: 1, max: 255 },
  email:               { type: 'string', max: 255 },
  phone:               { type: 'string', max: 30 },
  contact_name:        { type: 'string', max: 255 },
  commission_rate:     { type: 'number', min: 0, max: 100 },
  status:              { type: 'string', enum: ['active', 'suspended', 'inactive'] },
  brand_logo_url:      { type: 'string', max: 500 },
  brand_primary_color: { type: 'string', max: 7 },
  brand_accent_color:  { type: 'string', max: 7 },
  portal_domain:       { type: 'string', max: 255 },
  portal_name:         { type: 'string', max: 255 },
  notes:               { type: 'string' },
};

const planPriceSchema = {
  plan_id:      { type: 'number', required: true },
  custom_price: { type: 'number', required: true, min: 0 },
  currency:     { type: 'string', max: 3 },
  is_active:    { type: 'boolean' },
  notes:        { type: 'string' },
};

const bandwidthQuotaSchema = {
  download_mbps:       { type: 'number', min: 0 },
  upload_mbps:         { type: 'number', min: 0 },
  burst_download_mbps: { type: 'number', min: 0 },
  burst_upload_mbps:   { type: 'number', min: 0 },
  is_enforced:         { type: 'boolean' },
  notes:               { type: 'string' },
};

const billingEntitySchema = {
  legal_name:     { type: 'string', required: true, min: 1, max: 255 },
  tax_id:         { type: 'string', max: 50 },
  address:        { type: 'string' },
  city:           { type: 'string', max: 100 },
  state:          { type: 'string', max: 100 },
  country:        { type: 'string', max: 100 },
  zip_code:       { type: 'string', max: 20 },
  phone:          { type: 'string', max: 30 },
  email:          { type: 'string', max: 255 },
  invoice_prefix: { type: 'string', max: 20 },
  invoice_footer: { type: 'string' },
  bank_name:      { type: 'string', max: 255 },
  bank_account:   { type: 'string', max: 100 },
  bank_clabe:     { type: 'string', max: 18 },
  currency:       { type: 'string', max: 3 },
  is_active:      { type: 'boolean' },
};

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

// Binding management decides which subtree another user may reach, so a
// reseller-bound caller can never use it, whatever permissions it holds.
function requireOrgLevelResellerAccess(req, _res, next) {
  if (!req.resellerScope || !req.resellerScope.all) {
    return next(new ForbiddenError('Reseller-bound users cannot manage reseller bindings'));
  }
  next();
}

// =============================================================================
// §19.1 Reseller CRUD
// =============================================================================

// GET /resellers
router.get('/', requirePermission('resellers.view'), async (req, res, next) => {
  try {
    const { page = 1, limit = 50, status, parent_id } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10)), 100);
    const offset = (pageNum - 1) * limitNum;

    const conditions = ['r.organization_id = ? AND r.deleted_at IS NULL'];
    const params = [req.orgId];
    if (!req.resellerScope.all) {
      conditions.push(`r.id IN (${inPlaceholders(req.resellerScope.resellerIds)})`);
      params.push(...req.resellerScope.resellerIds);
    }
    if (status) { conditions.push('r.status = ?'); params.push(status); }
    if (parent_id !== undefined) {
      if (parent_id === 'null') {
        conditions.push('r.parent_id IS NULL');
      } else {
        conditions.push('r.parent_id = ?'); params.push(parseInt(parent_id, 10));
      }
    }

    const where = conditions.join(' AND ');
    const [rows] = await db.query(
      `SELECT r.*, p.name AS parent_name
       FROM resellers r
       LEFT JOIN resellers p ON r.parent_id = p.id
       WHERE ${where} ORDER BY r.level ASC, r.name ASC LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM resellers r WHERE ${where}`, params,
    );
    res.json({ data: rows, meta: { total, page: pageNum, limit: limitNum } });
  } catch (err) { next(err); }
});

// POST /resellers
router.post('/', requirePermission('resellers.create'), validate(createResellerSchema), async (req, res, next) => {
  try {
    const {
      name, email, phone, contact_name, parent_id, commission_rate = 0,
      status = 'active', brand_logo_url, brand_primary_color, brand_accent_color,
      portal_domain, portal_name, notes,
    } = req.body;

    // A reseller-bound caller may only add sub-resellers inside its subtree.
    if (!req.resellerScope.all && !parent_id) {
      throw new ForbiddenError('Reseller-bound users can only create sub-resellers of their own reseller');
    }
    if (parent_id && !resellerInScope(req.resellerScope, parent_id)) {
      throw new ValidationError('parent_id: parent reseller not found');
    }

    let level = 1;
    if (parent_id) {
      const [[parent]] = await db.query(
        'SELECT level FROM resellers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
        [parent_id, req.orgId],
      );
      if (!parent) throw new ValidationError('parent_id: parent reseller not found');
      level = parent.level + 1;
      if (level > 2) throw new ValidationError('Reseller hierarchy limited to 2 levels');
    }

    const [result] = await db.query(
      `INSERT INTO resellers (organization_id, parent_id, level, name, email, phone, contact_name,
        commission_rate, status, brand_logo_url, brand_primary_color, brand_accent_color,
        portal_domain, portal_name, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.orgId, parent_id || null, level, name, email || null, phone || null,
        contact_name || null, commission_rate, status,
        brand_logo_url || null, brand_primary_color || null, brand_accent_color || null,
        portal_domain || null, portal_name || null, notes || null],
    );
    const [[row]] = await db.query('SELECT * FROM resellers WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: row });
  } catch (err) { next(err); }
});

// GET /resellers/:id
router.get('/:id', requirePermission('resellers.view'), async (req, res, next) => {
  try {
    const row = await getResellerOrThrow(req);
    res.json({ data: row });
  } catch (err) { next(err); }
});

// PUT /resellers/:id
router.put('/:id', requirePermission('resellers.update'), validate(updateResellerSchema), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const {
      name, email, phone, contact_name, commission_rate,
      status, brand_logo_url, brand_primary_color, brand_accent_color,
      portal_domain, portal_name, notes,
    } = req.body;

    await db.query(
      `UPDATE resellers SET
        name = COALESCE(?, name), email = COALESCE(?, email), phone = COALESCE(?, phone),
        contact_name = COALESCE(?, contact_name), commission_rate = COALESCE(?, commission_rate),
        status = COALESCE(?, status), brand_logo_url = COALESCE(?, brand_logo_url),
        brand_primary_color = COALESCE(?, brand_primary_color),
        brand_accent_color = COALESCE(?, brand_accent_color),
        portal_domain = COALESCE(?, portal_domain), portal_name = COALESCE(?, portal_name),
        notes = COALESCE(?, notes)
       WHERE id = ?`,
      // Coalesce each optional field to null: an omitted key is `undefined`,
      // which mysql2's execute() rejects ("Bind parameters must not contain
      // undefined"); null lets COALESCE(?, col) keep the existing value.
      [name ?? null, email ?? null, phone ?? null, contact_name ?? null,
        commission_rate ?? null, status ?? null, brand_logo_url ?? null,
        brand_primary_color ?? null, brand_accent_color ?? null,
        portal_domain ?? null, portal_name ?? null, notes ?? null, req.params.id],
    );
    const [[row]] = await db.query('SELECT * FROM resellers WHERE id = ?', [req.params.id]);
    res.json({ data: row });
  } catch (err) { next(err); }
});

// DELETE /resellers/:id
router.delete('/:id', requirePermission('resellers.delete'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    await db.query('UPDATE resellers SET deleted_at = NOW() WHERE id = ?', [req.params.id]);
    res.json({ data: { id: parseInt(req.params.id, 10), deleted: true } });
  } catch (err) { next(err); }
});

// POST /resellers/:id/suspend
router.post('/:id/suspend', requirePermission('resellers.suspend'), async (req, res, next) => {
  try {
    const row = await getResellerOrThrow(req);
    const newStatus = row.status === 'suspended' ? 'active' : 'suspended';
    await db.query('UPDATE resellers SET status = ? WHERE id = ?', [newStatus, req.params.id]);
    res.json({ data: { id: parseInt(req.params.id, 10), status: newStatus } });
  } catch (err) { next(err); }
});

// =============================================================================
// §19.1 Custom Plan Prices
// =============================================================================

// GET /resellers/:id/plan-prices
router.get('/:id/plan-prices', requirePermission('reseller_plan_prices.view'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const [rows] = await db.query(
      `SELECT rpp.*, p.name AS plan_name, p.price AS base_price
       FROM reseller_plan_prices rpp
       JOIN plans p ON rpp.plan_id = p.id
       WHERE rpp.reseller_id = ?
       ORDER BY p.name ASC`,
      [req.params.id],
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// POST /resellers/:id/plan-prices
router.post('/:id/plan-prices', requirePermission('reseller_plan_prices.manage'), validate(planPriceSchema), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const { plan_id, custom_price, is_active = true, notes } = req.body;
    // Default to the organization's currency (not a hardcoded 'USD') when
    // the caller omits one — an explicitly-set currency always wins.
    const currency = req.body.currency || await Organization.getCurrency(req.orgId);

    await db.query(
      `INSERT INTO reseller_plan_prices (reseller_id, plan_id, custom_price, currency, is_active, notes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE custom_price = VALUES(custom_price), currency = VALUES(currency),
         is_active = VALUES(is_active), notes = VALUES(notes)`,
      [req.params.id, plan_id, custom_price, currency, is_active ? 1 : 0, notes || null],
    );
    const [[row]] = await db.query(
      'SELECT * FROM reseller_plan_prices WHERE reseller_id = ? AND plan_id = ?',
      [req.params.id, plan_id],
    );
    res.status(201).json({ data: row });
  } catch (err) { next(err); }
});

// DELETE /resellers/:id/plan-prices/:ppId
router.delete('/:id/plan-prices/:ppId', requirePermission('reseller_plan_prices.manage'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const [[pp]] = await db.query(
      'SELECT id FROM reseller_plan_prices WHERE id = ? AND reseller_id = ?',
      [req.params.ppId, req.params.id],
    );
    if (!pp) throw new NotFoundError('Plan price not found');
    await db.query('DELETE FROM reseller_plan_prices WHERE id = ?', [req.params.ppId]);
    res.json({ data: { id: parseInt(req.params.ppId, 10), deleted: true } });
  } catch (err) { next(err); }
});

// =============================================================================
// §19.1 Commission Records
// =============================================================================

// GET /resellers/:id/commissions
router.get('/:id/commissions', requirePermission('reseller_commissions.view'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const { status, page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10)), 100);
    const offset = (pageNum - 1) * limitNum;

    const conditions = ['rc.reseller_id = ?'];
    const params = [req.params.id];
    if (status) { conditions.push('rc.status = ?'); params.push(status); }

    const where = conditions.join(' AND ');
    const [rows] = await db.query(
      `SELECT rc.*, c.name AS client_name, i.invoice_number
       FROM reseller_commissions rc
       LEFT JOIN clients c ON rc.client_id = c.id
       LEFT JOIN invoices i ON rc.invoice_id = i.id
       WHERE ${where} ORDER BY rc.created_at DESC LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM reseller_commissions rc WHERE ${where}`, params,
    );
    res.json({ data: rows, meta: { total, page: pageNum, limit: limitNum } });
  } catch (err) { next(err); }
});

// POST /resellers/:id/commissions/:cId/approve
router.post('/:id/commissions/:cId/approve', requirePermission('reseller_commissions.approve'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const [[comm]] = await db.query(
      'SELECT * FROM reseller_commissions WHERE id = ? AND reseller_id = ?',
      [req.params.cId, req.params.id],
    );
    if (!comm) throw new NotFoundError('Commission record not found');

    const newStatus = req.body.status === 'paid' ? 'paid' : 'approved';
    const paidAt = newStatus === 'paid' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;
    await db.query(
      'UPDATE reseller_commissions SET status = ?, paid_at = ? WHERE id = ?',
      [newStatus, paidAt, req.params.cId],
    );
    const [[updated]] = await db.query('SELECT * FROM reseller_commissions WHERE id = ?', [req.params.cId]);
    res.json({ data: updated });
  } catch (err) { next(err); }
});

// =============================================================================
// §19.2 IP Pool Allocations
// =============================================================================

// GET /resellers/:id/ip-pools
router.get('/:id/ip-pools', requirePermission('reseller_ip_pool_allocations.view'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const [rows] = await db.query(
      `SELECT a.*, p.network, p.subnet_mask, p.ip_version, p.name AS pool_name, p.status AS pool_status
       FROM reseller_ip_pool_allocations a
       JOIN ip_pools p ON a.ip_pool_id = p.id
       WHERE a.reseller_id = ?
       ORDER BY p.network ASC`,
      [req.params.id],
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// POST /resellers/:id/ip-pools
router.post('/:id/ip-pools', requirePermission('reseller_ip_pool_allocations.manage'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const { ip_pool_id, notes } = req.body;
    if (!ip_pool_id) throw new ValidationError('ip_pool_id is required');

    await db.query(
      `INSERT IGNORE INTO reseller_ip_pool_allocations (reseller_id, ip_pool_id, notes)
       VALUES (?, ?, ?)`,
      [req.params.id, ip_pool_id, notes || null],
    );
    const [[row]] = await db.query(
      'SELECT * FROM reseller_ip_pool_allocations WHERE reseller_id = ? AND ip_pool_id = ?',
      [req.params.id, ip_pool_id],
    );
    res.status(201).json({ data: row });
  } catch (err) { next(err); }
});

// DELETE /resellers/:id/ip-pools/:allocId
router.delete('/:id/ip-pools/:allocId', requirePermission('reseller_ip_pool_allocations.manage'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const [[alloc]] = await db.query(
      'SELECT id FROM reseller_ip_pool_allocations WHERE id = ? AND reseller_id = ?',
      [req.params.allocId, req.params.id],
    );
    if (!alloc) throw new NotFoundError('IP pool allocation not found');
    await db.query('DELETE FROM reseller_ip_pool_allocations WHERE id = ?', [req.params.allocId]);
    res.json({ data: { id: parseInt(req.params.allocId, 10), deleted: true } });
  } catch (err) { next(err); }
});

// =============================================================================
// §19.2 Bandwidth Quota
// =============================================================================

// GET /resellers/:id/bandwidth-quota
router.get('/:id/bandwidth-quota', requirePermission('reseller_bandwidth_quotas.view'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const [[row]] = await db.query(
      'SELECT * FROM reseller_bandwidth_quotas WHERE reseller_id = ?',
      [req.params.id],
    );
    res.json({ data: row || null });
  } catch (err) { next(err); }
});

// PUT /resellers/:id/bandwidth-quota
router.put('/:id/bandwidth-quota', requirePermission('reseller_bandwidth_quotas.manage'), validate(bandwidthQuotaSchema), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const {
      download_mbps, upload_mbps, burst_download_mbps, burst_upload_mbps,
      is_enforced = true, notes,
    } = req.body;

    await db.query(
      `INSERT INTO reseller_bandwidth_quotas
         (reseller_id, download_mbps, upload_mbps, burst_download_mbps, burst_upload_mbps, is_enforced, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         download_mbps = VALUES(download_mbps), upload_mbps = VALUES(upload_mbps),
         burst_download_mbps = VALUES(burst_download_mbps),
         burst_upload_mbps = VALUES(burst_upload_mbps),
         is_enforced = VALUES(is_enforced), notes = VALUES(notes)`,
      [req.params.id, download_mbps || null, upload_mbps || null,
        burst_download_mbps || null, burst_upload_mbps || null,
        is_enforced ? 1 : 0, notes || null],
    );
    const [[row]] = await db.query(
      'SELECT * FROM reseller_bandwidth_quotas WHERE reseller_id = ?', [req.params.id],
    );
    res.json({ data: row });
  } catch (err) { next(err); }
});

// =============================================================================
// §19.2 OLT Port Assignments
// =============================================================================

// GET /resellers/:id/olt-ports
router.get('/:id/olt-ports', requirePermission('reseller_olt_port_assignments.view'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const [rows] = await db.query(
      `SELECT a.*, p.port_name, p.port_no, p.port_type
       FROM reseller_olt_port_assignments a
       JOIN olt_ports p ON a.olt_port_id = p.id
       WHERE a.reseller_id = ?
       ORDER BY p.port_index ASC`,
      [req.params.id],
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// POST /resellers/:id/olt-ports
router.post('/:id/olt-ports', requirePermission('reseller_olt_port_assignments.manage'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const { olt_port_id, notes } = req.body;
    if (!olt_port_id) throw new ValidationError('olt_port_id is required');

    await db.query(
      `INSERT IGNORE INTO reseller_olt_port_assignments (reseller_id, olt_port_id, notes)
       VALUES (?, ?, ?)`,
      [req.params.id, olt_port_id, notes || null],
    );
    const [[row]] = await db.query(
      'SELECT * FROM reseller_olt_port_assignments WHERE reseller_id = ? AND olt_port_id = ?',
      [req.params.id, olt_port_id],
    );
    res.status(201).json({ data: row });
  } catch (err) { next(err); }
});

// DELETE /resellers/:id/olt-ports/:aId
router.delete('/:id/olt-ports/:aId', requirePermission('reseller_olt_port_assignments.manage'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const [[asgn]] = await db.query(
      'SELECT id FROM reseller_olt_port_assignments WHERE id = ? AND reseller_id = ?',
      [req.params.aId, req.params.id],
    );
    if (!asgn) throw new NotFoundError('OLT port assignment not found');
    await db.query('DELETE FROM reseller_olt_port_assignments WHERE id = ?', [req.params.aId]);
    res.json({ data: { id: parseInt(req.params.aId, 10), deleted: true } });
  } catch (err) { next(err); }
});

// =============================================================================
// §19.2 Billing Entity
// =============================================================================

// GET /resellers/:id/billing-entity
router.get('/:id/billing-entity', requirePermission('reseller_billing_entities.view'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const [[row]] = await db.query(
      'SELECT * FROM reseller_billing_entities WHERE reseller_id = ?', [req.params.id],
    );
    res.json({ data: row || null });
  } catch (err) { next(err); }
});

// PUT /resellers/:id/billing-entity
router.put('/:id/billing-entity', requirePermission('reseller_billing_entities.manage'), validate(billingEntitySchema), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const {
      legal_name, tax_id, address, city, state, country, zip_code,
      phone, email, invoice_prefix, invoice_footer,
      bank_name, bank_account, bank_clabe, is_active = true,
    } = req.body;
    // Default to the organization's currency (not a hardcoded 'USD') when
    // the caller omits one — an explicitly-set currency always wins.
    const currency = req.body.currency || await Organization.getCurrency(req.orgId);

    await db.query(
      `INSERT INTO reseller_billing_entities
         (reseller_id, legal_name, tax_id, address, city, state, country, zip_code,
          phone, email, invoice_prefix, invoice_footer, bank_name, bank_account,
          bank_clabe, currency, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         legal_name = VALUES(legal_name), tax_id = VALUES(tax_id),
         address = VALUES(address), city = VALUES(city), state = VALUES(state),
         country = VALUES(country), zip_code = VALUES(zip_code), phone = VALUES(phone),
         email = VALUES(email), invoice_prefix = VALUES(invoice_prefix),
         invoice_footer = VALUES(invoice_footer), bank_name = VALUES(bank_name),
         bank_account = VALUES(bank_account), bank_clabe = VALUES(bank_clabe),
         currency = VALUES(currency), is_active = VALUES(is_active)`,
      [req.params.id, legal_name, tax_id || null, address || null, city || null,
        state || null, country || 'MX', zip_code || null, phone || null, email || null,
        invoice_prefix || null, invoice_footer || null, bank_name || null,
        bank_account || null, bank_clabe || null, currency, is_active ? 1 : 0],
    );
    const [[row]] = await db.query(
      'SELECT * FROM reseller_billing_entities WHERE reseller_id = ?', [req.params.id],
    );
    res.json({ data: row });
  } catch (err) { next(err); }
});

// =============================================================================
// User bindings (TNB-13, migration 475)
// =============================================================================
// A bound user is confined to the reseller's subtree on every /resellers and
// /reseller-portal route. Managing bindings decides another user's access, so
// it needs both resellers.update and users.update, and is org-level only.

function parseUserIdParam(req) {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) throw new NotFoundError('User');
  return userId;
}

// GET /resellers/:id/users
router.get('/:id/users', requirePermission('resellers.view'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    const [bindings] = await db.query(
      `SELECT id, user_id, reseller_id, created_by, created_at, updated_at
       FROM reseller_user_bindings
       WHERE organization_id = ? AND reseller_id = ?
       ORDER BY id ASC`,
      [req.orgId, req.params.id],
    );
    // Staff identities live in the primary database.
    const userIds = bindings.map((b) => b.user_id);
    let users = [];
    if (userIds.length) {
      [users] = await runInPrimaryContext(() => db.query(
        `SELECT id, first_name, last_name, email, status
         FROM users WHERE id IN (${inPlaceholders(userIds)}) AND deleted_at IS NULL`,
        userIds,
      ));
    }
    const byId = new Map(users.map((u) => [Number(u.id), u]));
    res.json({
      data: bindings.map((b) => {
        const u = byId.get(Number(b.user_id));
        return {
          ...b,
          first_name: u ? u.first_name : null,
          last_name: u ? u.last_name : null,
          email: u ? u.email : null,
          user_status: u ? u.status : null,
        };
      }),
    });
  } catch (err) { next(err); }
});

// PUT /resellers/:id/users/:userId — bind (or move) a user to this reseller
router.put(
  '/:id/users/:userId',
  requirePermission('resellers.update'),
  requirePermission('users.update'),
  requireOrgLevelResellerAccess,
  async (req, res, next) => {
    try {
      await getResellerOrThrow(req);
      const userId = parseUserIdParam(req);
      // Binding yourself would immediately revoke your own ability to undo it.
      if (userId === Number(req.user.id)) {
        throw new ValidationError('You cannot bind your own account to a reseller');
      }
      // Same organization-visibility rule as the Users page (home org,
      // explicit membership, or an installation-wide identity).
      const visible = await User.count({ where: { id: userId }, orgId: req.orgId });
      if (!Number(visible)) throw new NotFoundError('User');

      const [[previous]] = await db.query(
        'SELECT reseller_id FROM reseller_user_bindings WHERE organization_id = ? AND user_id = ?',
        [req.orgId, userId],
      );
      await db.query(
        `INSERT INTO reseller_user_bindings (organization_id, user_id, reseller_id, created_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE reseller_id = VALUES(reseller_id), created_by = VALUES(created_by)`,
        [req.orgId, userId, req.params.id, req.user.id],
      );
      const [[row]] = await db.query(
        `SELECT id, organization_id, user_id, reseller_id, created_by, created_at, updated_at
         FROM reseller_user_bindings WHERE organization_id = ? AND user_id = ?`,
        [req.orgId, userId],
      );
      await auditLog.log({
        userId: req.user.id,
        organizationId: req.orgId,
        action: previous ? 'update' : 'create',
        tableName: 'reseller_user_bindings',
        recordId: row ? row.id : null,
        oldValues: previous || null,
        newValues: { user_id: userId, reseller_id: Number(req.params.id) },
      });
      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

// DELETE /resellers/:id/users/:userId — remove the user's binding
router.delete(
  '/:id/users/:userId',
  requirePermission('resellers.update'),
  requirePermission('users.update'),
  requireOrgLevelResellerAccess,
  async (req, res, next) => {
    try {
      await getResellerOrThrow(req);
      const userId = parseUserIdParam(req);
      const [result] = await db.query(
        'DELETE FROM reseller_user_bindings WHERE organization_id = ? AND user_id = ? AND reseller_id = ?',
        [req.orgId, userId, req.params.id],
      );
      if (!result || !result.affectedRows) throw new NotFoundError('Reseller binding');
      await auditLog.log({
        userId: req.user.id,
        organizationId: req.orgId,
        action: 'delete',
        tableName: 'reseller_user_bindings',
        recordId: null,
        oldValues: { user_id: userId, reseller_id: Number(req.params.id) },
      });
      res.json({ data: { user_id: userId, reseller_id: Number(req.params.id), deleted: true } });
    } catch (err) { next(err); }
  },
);

module.exports = router;
