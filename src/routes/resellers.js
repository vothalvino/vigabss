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
//  GET    /resellers/:id/commissions       its commissions (earned / reversed), migration 007
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
//  User bindings (TNB-13, migration 471)
//  GET    /resellers/:id/users             list users bound to the reseller
//  POST   /resellers/:id/users             create a reseller login, bound to it
//  PUT    /resellers/:id/users/:userId     bind (or re-bind) a user to it
//  DELETE /resellers/:id/users/:userId     remove the user's binding
//
//  Reseller app (migration 003)
//  GET    /resellers/:id/allowed-plans     plans the reseller may offer
//  PUT    /resellers/:id/allowed-plans     replace that set
//
//  Reseller cash ledger (migration 004)
//  GET    /resellers/:id/ledger            entries and summary (balance, in bags, limit, available)
//  POST   /resellers/:id/ledger            record a deposit (cash handed in), a payout (the ISP pays
//                                          what it owes the reseller) or an adjustment
//
//  Cash bags (migration 005)
//  GET    /resellers/:id/bags              the reseller's cash bags, their history and differences
//
//  Every route is confined to the caller's reseller scope: a bound user only
//  sees its own subtree (404 outside it, GET / filtered), an unbound
//  reseller_admin is refused, and org-level staff see every reseller in their
//  organization. Binding management, allowed plans, suspend, plan prices and
//  the resource and billing-entity writes are
//  org-level only (requireOrgLevelResellerAccess, requireIspDecision), and so
//  are the cash ledger and a reseller's credit_limit. See
//  middleware/resellerScope.js.
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { resellerScope, assertResellerInScope, resellerInScope } = require('../middleware/resellerScope');
const bcrypt = require('bcryptjs');
const { AppError, ForbiddenError, NotFoundError, ValidationError, ConflictError } = require('../utils/errors');
const { createUser: createUserSchema } = require('../middleware/schemas/users');
const { SALT_ROUNDS: PASSWORD_SALT_ROUNDS } = require('../middleware/hashPassword');
const { assertPasswordAllowed } = require('../services/passwordPolicyService');
const Organization = require('../models/Organization');
const User = require('../models/User');
const auditLog = require('../services/auditLog');
const db = require('../config/database');
const { inPlaceholders } = require('../utils/sqlBuild');
const { runInPrimaryContext } = require('../utils/primaryContext');
const { ownedReferences } = require('../utils/ownedReferences');
const money = require('../utils/money');
const resellerLedgerService = require('../services/resellerLedgerService');
const resellerCommissionService = require('../services/resellerCommissionService');
const collectorService = require('../services/collectorService');
const cashBagService = require('../services/cashBagService');
const resellerSettlementService = require('../services/resellerSettlementService');
const resellerStatementPdf = require('../services/resellerStatementPdf');
const { isCarrierUser } = require('../services/carrierAccount');

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
  // Where the carrier goes (migration 005).
  address:             { type: 'string', max: 255, nullable: true },
  city:                { type: 'string', max: 100, nullable: true },
  latitude:            { type: 'number', min: -90, max: 90, nullable: true },
  longitude:           { type: 'number', min: -180, max: 180, nullable: true },
  parent_id:           { type: 'number' },
  // A point that only takes payments (migration 011).
  kind:                { type: 'string', enum: ['reseller', 'collector'] },
  collection_fee_type: { type: 'string', enum: ['none', 'fixed', 'percent'] },
  collection_fee_value: { type: 'number', min: 0, max: 99999999.99 },
  commission_rate:     { type: 'number', min: 0, max: 100 },
  // Cash the reseller may hold before handing it in; null = organization default.
  credit_limit:        { type: 'number', min: 0, max: 9999999999.99, nullable: true },
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
  // Where the carrier goes (migration 005).
  address:             { type: 'string', max: 255, nullable: true },
  city:                { type: 'string', max: 100, nullable: true },
  latitude:            { type: 'number', min: -90, max: 90, nullable: true },
  longitude:           { type: 'number', min: -180, max: 180, nullable: true },
  kind:                { type: 'string', enum: ['reseller', 'collector'] },
  collection_fee_type: { type: 'string', enum: ['none', 'fixed', 'percent'] },
  collection_fee_value: { type: 'number', min: 0, max: 99999999.99 },
  commission_rate:     { type: 'number', min: 0, max: 100 },
  // Cash the reseller may hold before handing it in; null = organization default.
  credit_limit:        { type: 'number', min: 0, max: 9999999999.99, nullable: true },
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

// Allocations named another tenant's plan, pool or port, and the lists joined
// those rows in (TNB-19): the ids are checked and the joins scoped.
const ipPoolAllocationSchema = {
  ip_pool_id: { type: 'number', required: true },
  notes:      { type: 'string' },
};

const oltPortAssignmentSchema = {
  olt_port_id: { type: 'number', required: true },
  notes:       { type: 'string' },
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

// Some reseller routes are the ISP's decisions about a reseller, never
// reseller self-service, so a reseller-bound caller can never use them,
// whatever permissions its group holds (a binding is allowed for a user in
// any group):
//   - binding management decides which subtree another user may reach, and
//     the allowed plans what a reseller may sell;
//   - suspending or reactivating a reseller, approving or paying its
//     commissions, and its wholesale prices, IP pools, OLT ports, bandwidth
//     quota and billing entity.
function orgLevelOnly(message) {
  return function requireOrgLevel(req, _res, next) {
    if (!req.resellerScope || !req.resellerScope.all) return next(new ForbiddenError(message));
    next();
  };
}
const requireOrgLevelResellerAccess = orgLevelOnly('Reseller-bound users cannot manage reseller bindings');
const requireIspDecision = orgLevelOnly('Only the ISP can change this for a reseller');

// A reseller-bound caller may name and describe its sub-resellers, but what a
// reseller earns, how much cash it may hold and whether it may operate are
// the ISP's decisions.
const ORG_LEVEL_RESELLER_FIELDS = ['commission_rate', 'status', 'credit_limit', 'kind', 'collection_fee_type', 'collection_fee_value'];
function rejectResellerEscalation(req) {
  if (req.resellerScope.all) return;
  const body = req.body || {};
  const set = ORG_LEVEL_RESELLER_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(body, f) && body[f] !== undefined);
  if (set.length) {
    throw new ForbiddenError(`Reseller-bound users cannot set ${set.join(' or ')}`);
  }
}

// credit_limit: a non-negative amount with at most 2 decimals, or null for the
// organization default. Returns { present, value }.
function creditLimitFromBody(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'credit_limit') || body.credit_limit === undefined) {
    return { present: false, value: null };
  }
  const value = body.credit_limit;
  if (value === null || value === '') return { present: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || money.round(value) !== value) {
    throw new ValidationError('credit_limit must be an amount of 0 or more with at most 2 decimals, or null for the organization default');
  }
  return { present: true, value };
}

// Rows of /resellers carry the money position: the effective credit limit
// (credit_limit is the reseller's own column, null = the organization
// default), the ledger balance, which is also the cash still on hand (a
// sealed bag's cash leaves it at sealing), the cash in sealed bags on their
// way to the ISP (in_bags, for information) and what it may still collect.
async function withMoney(orgId, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return rows;
  const ids = list.map((r) => r.id);
  const [balances, bagged, orgDefault] = await Promise.all([
    resellerLedgerService.balancesFor(orgId, ids),
    resellerLedgerService.inBagsFor(orgId, ids),
    resellerLedgerService.defaultCreditLimit(orgId),
  ]);
  for (const r of list) {
    const limit = resellerLedgerService.effectiveCreditLimit(r.credit_limit, orgDefault);
    const summary = resellerLedgerService.summarize(balances.get(Number(r.id)) ?? 0, limit, bagged.get(Number(r.id)) ?? 0);
    r.effective_credit_limit = summary.credit_limit;
    r.balance = summary.balance;
    r.in_bags = summary.in_bags;
    r.cash_on_hand = summary.cash_on_hand;
    r.available_to_collect = summary.available_to_collect;
  }
  return rows;
}

// Where the carrier goes: address, city and the coordinates. Each field is
// { present, value }: present when the key was sent (an update leaves an
// absent field unchanged), value null when it was sent empty or null (an
// update clears it). latitude and longitude are sent together and are both
// set or both cleared.
function locationFromBody(body) {
  const b = body || {};
  const sent = (k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;
  const blank = (k) => b[k] === null || b[k] === '';
  const text = (k) => ({
    present: sent(k),
    value: typeof b[k] === 'string' && b[k].trim() ? b[k].trim() : null,
  });
  if (sent('latitude') !== sent('longitude') || (sent('latitude') && blank('latitude') !== blank('longitude'))) {
    throw new ValidationError('latitude and longitude must be sent together (both set, or both empty to clear them)');
  }
  const coord = (k) => ({ present: sent(k), value: sent(k) && !blank(k) ? b[k] : null });
  return { address: text('address'), city: text('city'), latitude: coord('latitude'), longitude: coord('longitude') };
}

// =============================================================================
// §19.1 Reseller CRUD
// =============================================================================

// GET /resellers
router.get('/', requirePermission('resellers.view'), async (req, res, next) => {
  try {
    const { page = 1, limit = 50, status, parent_id, kind } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
    const offset = (pageNum - 1) * limitNum;

    const conditions = ['r.organization_id = ? AND r.deleted_at IS NULL'];
    const params = [req.orgId];
    if (!req.resellerScope.all) {
      conditions.push(`r.id IN (${inPlaceholders(req.resellerScope.resellerIds)})`);
      params.push(...req.resellerScope.resellerIds);
    }
    if (status) { conditions.push('r.status = ?'); params.push(status); }
    if (kind !== undefined && kind !== '') {
      if (!collectorService.KINDS.includes(kind)) throw new ValidationError('kind must be reseller or collector');
      conditions.push('r.kind = ?'); params.push(kind);
    }
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
       WHERE ${where} ORDER BY r.level ASC, r.name ASC, r.id ASC LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM resellers r WHERE ${where}`, params,
    );
    await withMoney(req.orgId, rows);
    res.json({ data: rows, meta: { total, page: pageNum, limit: limitNum } });
  } catch (err) { next(err); }
});

// POST /resellers
router.post('/', requirePermission('resellers.create'), validate(createResellerSchema, { strip: false }), async (req, res, next) => {
  try {
    const {
      name, email, phone, contact_name, parent_id, commission_rate = 0,
      status = 'active', brand_logo_url, brand_primary_color, brand_accent_color,
      portal_domain, portal_name, notes,
    } = req.body;

    rejectResellerEscalation(req);
    const creditLimit = creditLimitFromBody(req.body);
    const location = locationFromBody(req.body);
    // A collector (migration 011) is a top-level point that only takes
    // payments: no parent, no commission, and never the parent of another.
    const kind = req.body.kind || 'reseller';
    if (kind === 'collector' && parent_id) throw new ValidationError('parent_id: a collector has no parent reseller');
    if (kind === 'collector' && Number(commission_rate) > 0) throw new ValidationError('commission_rate: a collector earns a collection fee, not a commission');
    if (parent_id) await collectorService.assertCanOwnClients(req.orgId, parent_id, db.query.bind(db), 'parent_id');
    const fee = collectorService.feeSettings(req.body, kind) || { type: 'none', value: 0 };
    if (kind === 'collector' && fee.type === null) fee.type = Number(fee.value) > 0 ? 'fixed' : 'none';
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
      `INSERT INTO resellers (organization_id, parent_id, level, kind, name, email, phone, contact_name,
        commission_rate, collection_fee_type, collection_fee_value, status, brand_logo_url, brand_primary_color, brand_accent_color,
        portal_domain, portal_name, notes, address, city, latitude, longitude, credit_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.orgId, parent_id || null, level, kind, name, email || null, phone || null,
        contact_name || null, commission_rate, fee.type, fee.value ?? 0, status,
        brand_logo_url || null, brand_primary_color || null, brand_accent_color || null,
        portal_domain || null, portal_name || null, notes || null,
        location.address.value, location.city.value, location.latitude.value, location.longitude.value,
        creditLimit.value],
    );
    const [[row]] = await db.query(
      'SELECT * FROM resellers WHERE id = ? AND organization_id = ?', [result.insertId, req.orgId],
    );
    if (row) await withMoney(req.orgId, row);
    res.status(201).json({ data: row });
  } catch (err) { next(err); }
});

// GET /resellers/:id
router.get('/:id', requirePermission('resellers.view'), async (req, res, next) => {
  try {
    const row = await getResellerOrThrow(req);
    await withMoney(req.orgId, row);
    res.json({ data: row });
  } catch (err) { next(err); }
});

/**
 * The new kind a PUT asks for, or null. Turning a reseller into a collector
 * (migration 011) needs a top-level reseller with no sub-resellers, clients
 * or leads: a collector never owns any (409 COLLECTOR_HAS_CLIENTS).
 */
async function kindChangeFor(req, existing) {
  const wanted = req.body.kind;
  if (wanted === undefined || wanted === (existing.kind || 'reseller')) return null;
  if (wanted === 'collector') {
    if (existing.parent_id !== null && existing.parent_id !== undefined) {
      throw new ValidationError('kind: a sub-reseller cannot be a collector');
    }
    const [[owned]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM resellers WHERE organization_id = ? AND parent_id = ? AND deleted_at IS NULL)
            + (SELECT COUNT(*) FROM clients WHERE organization_id = ? AND reseller_id = ? AND deleted_at IS NULL)
            + (SELECT COUNT(*) FROM leads WHERE organization_id = ? AND reseller_id = ? AND deleted_at IS NULL) AS n`,
      [req.orgId, existing.id, req.orgId, existing.id, req.orgId, existing.id],
    );
    if (Number(owned?.n) > 0) {
      throw new AppError('A reseller with sub-resellers, clients or leads cannot become a collector', 409, 'COLLECTOR_HAS_CLIENTS');
    }
  }
  return wanted;
}

// PUT /resellers/:id
router.put('/:id', requirePermission('resellers.update'), validate(updateResellerSchema, { strip: false }), async (req, res, next) => {
  try {
    const existing = await getResellerOrThrow(req);
    rejectResellerEscalation(req);
    const kindChange = await kindChangeFor(req, existing);
    const effectiveKind = kindChange || existing.kind || 'reseller';
    const fee = kindChange === 'reseller'
      ? { type: 'none', value: 0 }
      : collectorService.feeSettings(req.body, effectiveKind);
    if (effectiveKind === 'collector' && Number(req.body.commission_rate) > 0) {
      throw new ValidationError('commission_rate: a collector earns a collection fee, not a commission');
    }
    // credit_limit may be set back to null (the organization default) and the
    // location fields cleared, so they are not COALESCEd like the other
    // fields: IF(sent, value, unchanged).
    const creditLimit = creditLimitFromBody(req.body);
    const location = locationFromBody(req.body);
    const {
      name, email, phone, contact_name, commission_rate,
      status, brand_logo_url, brand_primary_color, brand_accent_color,
      portal_domain, portal_name, notes,
    } = req.body;

    await db.query(
      `UPDATE resellers SET
        kind = COALESCE(?, kind), collection_fee_type = COALESCE(?, collection_fee_type),
        collection_fee_value = COALESCE(?, collection_fee_value),
        name = COALESCE(?, name), email = COALESCE(?, email), phone = COALESCE(?, phone),
        contact_name = COALESCE(?, contact_name), commission_rate = COALESCE(?, commission_rate),
        status = COALESCE(?, status), brand_logo_url = COALESCE(?, brand_logo_url),
        brand_primary_color = COALESCE(?, brand_primary_color),
        brand_accent_color = COALESCE(?, brand_accent_color),
        portal_domain = COALESCE(?, portal_domain), portal_name = COALESCE(?, portal_name),
        notes = COALESCE(?, notes), address = IF(?, ?, address), city = IF(?, ?, city),
        latitude = IF(?, ?, latitude), longitude = IF(?, ?, longitude),
        credit_limit = IF(?, ?, credit_limit)
       WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
      // Coalesce each optional field to null: an omitted key is `undefined`,
      // which mysql2's execute() rejects ("Bind parameters must not contain
      // undefined"); null lets COALESCE(?, col) keep the existing value.
      [kindChange ?? null, fee ? fee.type : null, fee ? fee.value : null,
        name ?? null, email ?? null, phone ?? null, contact_name ?? null,
        kindChange === 'collector' ? 0 : commission_rate ?? null, status ?? null, brand_logo_url ?? null,
        brand_primary_color ?? null, brand_accent_color ?? null,
        portal_domain ?? null, portal_name ?? null, notes ?? null,
        ...['address', 'city', 'latitude', 'longitude'].flatMap((k) => [location[k].present ? 1 : 0, location[k].value]),
        creditLimit.present ? 1 : 0, creditLimit.value, req.params.id, req.orgId],
    );
    const [[row]] = await db.query(
      'SELECT * FROM resellers WHERE id = ? AND organization_id = ?', [req.params.id, req.orgId],
    );
    if (row) await withMoney(req.orgId, row);
    res.json({ data: row });
  } catch (err) { next(err); }
});

// DELETE /resellers/:id
router.delete('/:id', requirePermission('resellers.delete'), async (req, res, next) => {
  try {
    await getResellerOrThrow(req);
    await db.query(
      'UPDATE resellers SET deleted_at = NOW() WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [req.params.id, req.orgId],
    );
    res.json({ data: { id: parseInt(req.params.id, 10), deleted: true } });
  } catch (err) { next(err); }
});

// POST /resellers/:id/suspend
router.post('/:id/suspend', requirePermission('resellers.suspend'), requireIspDecision, async (req, res, next) => {
  try {
    const row = await getResellerOrThrow(req);
    const newStatus = row.status === 'suspended' ? 'active' : 'suspended';
    await db.query(
      'UPDATE resellers SET status = ? WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [newStatus, req.params.id, req.orgId],
    );
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
       WHERE rpp.reseller_id = ? AND p.organization_id <=> ?
       ORDER BY p.name ASC`,
      [req.params.id, req.orgId],
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// POST /resellers/:id/plan-prices
router.post('/:id/plan-prices', requirePermission('reseller_plan_prices.manage'), requireIspDecision, validate(planPriceSchema, { strip: false }), ownedReferences({ plan_id: 'plans' }), async (req, res, next) => {
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
router.delete('/:id/plan-prices/:ppId', requirePermission('reseller_plan_prices.manage'), requireIspDecision, async (req, res, next) => {
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
// Commissions (reseller program phase 4, migration 007)
// =============================================================================
// services/resellerCommissionService.js writes them: a commission is earned
// when an invoice of a client of the reseller's subtree becomes paid and
// reversed when it stops being paid, each with its line in the cash ledger.
// They are booked on the top-level reseller, so a sub-reseller has none.
// Nothing approves or pays a commission by hand any more: the reseller keeps
// it from the cash, and a negative balance is paid with a ledger payout.

const COMMISSION_STATUSES = ['earned', 'reversed'];

// GET /resellers/:id/commissions
router.get('/:id/commissions', requirePermission('reseller_commissions.view'), async (req, res, next) => {
  try {
    const reseller = await getResellerOrThrow(req);
    const status = req.query.status === undefined || req.query.status === '' ? null : String(req.query.status);
    if (status !== null && !COMMISSION_STATUSES.includes(status)) {
      throw new ValidationError(`status must be one of ${COMMISSION_STATUSES.join(', ')}`);
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 50), 100);
    const { rows, total, summary } = await resellerCommissionService.listCommissions(
      req.orgId, Number(reseller.id), { status, limit, offset: (page - 1) * limit },
    );
    res.json({ data: rows, summary, meta: { total, page, limit } });
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
       WHERE a.reseller_id = ? AND p.organization_id <=> ?
       ORDER BY p.network ASC`,
      [req.params.id, req.orgId],
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// POST /resellers/:id/ip-pools
router.post('/:id/ip-pools', requirePermission('reseller_ip_pool_allocations.manage'), requireIspDecision, validate(ipPoolAllocationSchema, { strip: false }), ownedReferences({ ip_pool_id: 'ip_pools' }), async (req, res, next) => {
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
router.delete('/:id/ip-pools/:allocId', requirePermission('reseller_ip_pool_allocations.manage'), requireIspDecision, async (req, res, next) => {
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
router.put('/:id/bandwidth-quota', requirePermission('reseller_bandwidth_quotas.manage'), requireIspDecision, validate(bandwidthQuotaSchema, { strip: false }), async (req, res, next) => {
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
       WHERE a.reseller_id = ? AND p.organization_id <=> ?
       ORDER BY p.port_index ASC`,
      [req.params.id, req.orgId],
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// POST /resellers/:id/olt-ports
router.post('/:id/olt-ports', requirePermission('reseller_olt_port_assignments.manage'), requireIspDecision, validate(oltPortAssignmentSchema, { strip: false }), ownedReferences({ olt_port_id: 'olt_ports' }), async (req, res, next) => {
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
router.delete('/:id/olt-ports/:aId', requirePermission('reseller_olt_port_assignments.manage'), requireIspDecision, async (req, res, next) => {
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
router.put('/:id/billing-entity', requirePermission('reseller_billing_entities.manage'), requireIspDecision, validate(billingEntitySchema, { strip: false }), async (req, res, next) => {
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
// User bindings (TNB-13, migration 471)
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
      // A carrier works only in the carrier app; it is never also a reseller
      // account (migration 005).
      if (await isCarrierUser(userId)) {
        throw new ValidationError('A carrier account cannot be bound to a reseller');
      }

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

// POST /resellers/:id/users — create a reseller login and bind it here
// A staff user in the reseller_admin group, homed in this organization, with
// the same validation, password policy and email uniqueness as POST /users.
// The user lives in the primary database and the binding beside `resellers`,
// so the two writes cannot share a transaction; a failed binding archives
// the new user again.
const createResellerLoginSchema = Object.fromEntries(
  ['first_name', 'last_name', 'email', 'password'].map((field) => [field, { ...createUserSchema[field] }]),
);

router.post(
  '/:id/users',
  requirePermission('resellers.update'),
  // A reseller login is created only in the reseller_admin group, so the
  // narrower point_logins.create (manager, migration 010) is enough.
  requirePermission('users.create', 'point_logins.create'),
  requireOrgLevelResellerAccess,
  validate(createResellerLoginSchema, { strip: true }),
  async (req, res, next) => {
    try {
      const reseller = await getResellerOrThrow(req);
      const email = String(req.body.email).trim();
      const existing = await runInPrimaryContext(() => User.findByEmail(email));
      if (existing) throw new ConflictError('A user with this email already exists');
      // Same policy as an administrator-set password on POST /users.
      await assertPasswordAllowed(req.body.password, req.orgId);
      const passwordHash = await bcrypt.hash(req.body.password, PASSWORD_SALT_ROUNDS);

      // A collector's login goes in the collector group (migration 011): the
      // reseller app's cash routes only, never clients, leads or plans.
      const collector = reseller.kind === 'collector';
      const [[group]] = await runInPrimaryContext(() => db.query(collector
        ? "SELECT id FROM roles WHERE name = 'collector' AND is_system = 1 AND deleted_at IS NULL LIMIT 1"
        : "SELECT id FROM roles WHERE name = 'reseller_admin' AND is_system = 1 AND deleted_at IS NULL LIMIT 1"));
      if (!group) throw new ValidationError(`The ${collector ? 'collector' : 'reseller_admin'} user group is missing`);

      const user = await User.create({
        organization_id: req.orgId,
        first_name: req.body.first_name,
        last_name: req.body.last_name,
        email,
        password_hash: passwordHash,
        group_id: group.id,
        status: 'active',
      });
      await auditLog.log({
        userId: req.user.id,
        organizationId: req.orgId,
        action: 'create',
        tableName: 'users',
        recordId: user.id,
        newValues: { email, group_id: group.id, reseller_id: reseller.id },
      });

      let binding;
      try {
        await db.query(
          `INSERT INTO reseller_user_bindings (organization_id, user_id, reseller_id, created_by)
           VALUES (?, ?, ?, ?)`,
          [req.orgId, user.id, reseller.id, req.user.id],
        );
        [[binding]] = await db.query(
          'SELECT id FROM reseller_user_bindings WHERE organization_id = ? AND user_id = ?',
          [req.orgId, user.id],
        );
      } catch (err) {
        await User.delete(user.id, req.orgId).catch(() => {});
        throw err;
      }
      await auditLog.log({
        userId: req.user.id,
        organizationId: req.orgId,
        action: 'create',
        tableName: 'reseller_user_bindings',
        recordId: binding ? binding.id : null,
        newValues: { user_id: Number(user.id), reseller_id: Number(reseller.id) },
      });

      res.status(201).json({ data: { user_id: Number(user.id), email, reseller_id: Number(reseller.id) } });
    } catch (err) { next(err); }
  },
);

// =============================================================================
// Allowed plans (reseller app, migration 003)
// =============================================================================
// The plans a top-level reseller may offer in the reseller app; its
// sub-resellers offer the same set. No rows means every active plan of the
// organization (routes/resellerApp.js allowedPlans).

async function listAllowedPlans(orgId, resellerId) {
  const [rows] = await db.query(
    `SELECT rap.plan_id, p.name, p.price
       FROM reseller_allowed_plans rap
       JOIN plans p ON p.id = rap.plan_id AND p.organization_id = rap.organization_id AND p.deleted_at IS NULL
      WHERE rap.organization_id = ? AND rap.reseller_id = ?
      ORDER BY p.name ASC`,
    [orgId, resellerId],
  );
  return rows.map((r) => ({ plan_id: Number(r.plan_id), name: r.name, price: Number(r.price) }));
}

const allowedPlansSchema = {
  plan_ids: { type: 'array', required: true },
};

// GET /resellers/:id/allowed-plans
router.get('/:id/allowed-plans', requirePermission('resellers.view'), requireOrgLevelResellerAccess, async (req, res, next) => {
  try {
    const reseller = await getResellerOrThrow(req);
    res.json({ data: await listAllowedPlans(req.orgId, reseller.id) });
  } catch (err) { next(err); }
});

// PUT /resellers/:id/allowed-plans — replace the set
router.put(
  '/:id/allowed-plans',
  requirePermission('resellers.update'),
  requireOrgLevelResellerAccess,
  validate(allowedPlansSchema, { strip: true }),
  async (req, res, next) => {
    try {
      const reseller = await getResellerOrThrow(req);
      // Sub-resellers offer the plans of their top-level reseller
      // (routes/resellerApp.js allowedPlans), so a set stored on one would
      // never be used.
      if (reseller.parent_id !== null && reseller.parent_id !== undefined) {
        throw new ValidationError('Allowed plans are set on the top-level reseller; its sub-resellers offer the same plans');
      }
      const raw = req.body.plan_ids;
      if (!raw.every((id) => Number.isInteger(id) && id > 0)) {
        throw new ValidationError('plan_ids must be an array of plan ids');
      }
      if (raw.length > 500) throw new ValidationError('plan_ids: at most 500 plans');
      const planIds = [...new Set(raw)];
      if (planIds.length) {
        const [found] = await db.query(
          `SELECT id FROM plans WHERE organization_id = ? AND deleted_at IS NULL AND id IN (${inPlaceholders(planIds)})`,
          [req.orgId, ...planIds],
        );
        const known = new Set(found.map((p) => Number(p.id)));
        const missing = planIds.filter((id) => !known.has(id));
        if (missing.length) throw new ValidationError(`plan_ids: plan not found: ${missing.join(', ')}`);
      }

      const before = await listAllowedPlans(req.orgId, reseller.id);
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query(
          'DELETE FROM reseller_allowed_plans WHERE organization_id = ? AND reseller_id = ?',
          [req.orgId, reseller.id],
        );
        if (planIds.length) {
          await conn.query(
            `INSERT INTO reseller_allowed_plans (organization_id, reseller_id, plan_id)
             VALUES ${planIds.map(() => '(?, ?, ?)').join(', ')}`,
            planIds.flatMap((planId) => [req.orgId, reseller.id, planId]),
          );
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }

      await auditLog.log({
        userId: req.user.id,
        organizationId: req.orgId,
        action: 'update',
        tableName: 'reseller_allowed_plans',
        recordId: Number(reseller.id),
        oldValues: { plan_ids: before.map((p) => p.plan_id) },
        newValues: { plan_ids: planIds },
      });
      res.json({ data: await listAllowedPlans(req.orgId, reseller.id) });
    } catch (err) { next(err); }
  },
);

// =============================================================================
// Reseller cash ledger (reseller app phase 2, migration 004)
// =============================================================================
// What a collecting reseller owes the ISP (services/resellerLedgerService.js).
// Collections are booked on the top-level reseller of the user who took the
// money, so a sub-reseller has no ledger of its own. A deposit records cash
// the reseller handed in and frees its credit limit; it is never a payments
// row. A payout records what the ISP paid the reseller when its commissions
// passed what it holds (a negative balance, "Te debemos"). Staff post only
// deposits, payouts and adjustments: a collection, its void, a sealed bag
// (bag_sealed) and the commission lines are written by the flows they record.
// Org-level staff only: what a reseller owes is the ISP's record.

const ledgerEntrySchema = {
  entry_type: { type: 'string', required: true, enum: resellerLedgerService.MANUAL_ENTRY_TYPES },
  amount:     { type: 'number', required: true, min: -9999999999.99, max: 9999999999.99 },
  note:       { type: 'string', max: 500 },
};

function ledgerSummary(summary) {
  return {
    balance: summary.balance,
    in_bags: summary.in_bags,
    cash_on_hand: summary.cash_on_hand,
    credit_limit: summary.credit_limit,
    available_to_collect: summary.available_to_collect,
    limit_reached: summary.limit_reached,
    credit_limit_override: summary.credit_limit_override,
  };
}

// GET /resellers/:id/ledger
router.get('/:id/ledger', requirePermission('reseller_ledger.view'), requireIspDecision, async (req, res, next) => {
  try {
    const reseller = await getResellerOrThrow(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 25), 100);
    const [{ rows, total }, summary] = await Promise.all([
      resellerLedgerService.listEntries(req.orgId, reseller.id, { limit, offset: (page - 1) * limit }),
      resellerLedgerService.summaryFor(req.orgId, reseller.id, { reseller }),
    ]);
    res.json({ data: rows, summary: ledgerSummary(summary), meta: { total, page, limit } });
  } catch (err) { next(err); }
});

// POST /resellers/:id/ledger — a deposit (cash handed in) or an adjustment
router.post(
  '/:id/ledger',
  requirePermission('reseller_ledger.manage'),
  requireIspDecision,
  validate(ledgerEntrySchema),
  async (req, res, next) => {
    try {
      const found = await getResellerOrThrow(req);
      if (found.parent_id !== null && found.parent_id !== undefined) {
        throw new ValidationError('Cash is booked on the top-level reseller; record this on its parent reseller');
      }
      const { entry_type: entryType, amount } = req.body;
      const note = typeof req.body.note === 'string' && req.body.note.trim() ? req.body.note.trim() : null;
      if (money.round(amount) !== amount) throw new ValidationError('amount must have at most 2 decimals');
      if (entryType === 'deposit' && !(amount > 0)) throw new ValidationError('A deposit amount must be more than 0');
      if (entryType === 'payout' && !(amount > 0)) throw new ValidationError('A payout amount must be more than 0');
      if (entryType === 'adjustment' && amount === 0) throw new ValidationError('An adjustment amount must not be 0');
      if (entryType === 'adjustment' && !note) throw new ValidationError('An adjustment needs a note explaining it');

      const currency = await Organization.getCurrency(req.orgId);
      const conn = await db.getConnection();
      const exec = conn.execute.bind(conn);
      let entryId;
      let signed;
      try {
        await conn.beginTransaction();
        // The same lock a collection takes, so the balance cannot move under us.
        const reseller = await resellerLedgerService.lockReseller(exec, req.orgId, found.id);
        if (!reseller) throw new NotFoundError('Reseller');
        // A deposit is cash the reseller still holds (cash_on_hand, the
        // balance: what it sealed in bags already left it at sealing); more
        // would let it collect past its limit afterwards. An adjustment
        // corrects anything else.
        const position = await resellerLedgerService.summaryFor(req.orgId, reseller.id, { exec, reseller });
        if (entryType === 'deposit' && money.toCents(amount) > money.toCents(position.cash_on_hand)) {
          const err = new ValidationError(
            `The reseller holds ${position.cash_on_hand.toFixed(2)} in cash; a deposit cannot be more than that`,
          );
          err.code = 'DEPOSIT_EXCEEDS_BALANCE';
          throw err;
        }
        // A payout is what the ISP owes the reseller: its commissions passed
        // the cash it holds, so the balance is negative. More would make the
        // reseller owe the ISP the difference.
        if (entryType === 'payout' && money.toCents(amount) > -money.toCents(position.balance)) {
          const owed = Math.max(0, -position.balance);
          const err = new ValidationError(
            `The ISP owes the reseller ${owed.toFixed(2)}; a payout cannot be more than that`,
          );
          err.code = 'PAYOUT_EXCEEDS_OWED';
          throw err;
        }
        signed = entryType === 'deposit' ? -amount : amount;
        entryId = await resellerLedgerService.appendEntry(exec, {
          orgId: req.orgId, resellerId: reseller.id, entryType, amount: signed, currency,
          note, createdBy: req.user.id,
        });
        await conn.commit();
      } catch (err) {
        try { await conn.rollback(); } catch (_rollbackErr) { /* keep the original error */ }
        throw err;
      } finally {
        conn.release();
      }

      await auditLog.log({
        userId: req.user.id,
        organizationId: req.orgId,
        action: { deposit: 'reseller_deposit', payout: 'reseller_payout' }[entryType] || 'reseller_adjustment',
        tableName: 'reseller_ledger_entries',
        recordId: entryId,
        newValues: { reseller_id: Number(found.id), entry_type: entryType, amount: signed, currency, note },
      });
      const [[row]] = await db.query(
        `SELECT id, entry_type, amount, currency, note, created_at, payment_id, cash_session_id, created_by,
                cash_bag_id, invoice_id, commission_id
           FROM reseller_ledger_entries WHERE id = ? AND organization_id = ?`,
        [entryId, req.orgId],
      );
      const summary = await resellerLedgerService.summaryFor(req.orgId, found.id);
      res.status(201).json({
        data: resellerLedgerService.entryRow(row || {
          id: entryId, entry_type: entryType, amount: signed, currency, note, created_at: null, created_by: req.user.id,
        }),
        summary: ledgerSummary(summary),
      });
    } catch (err) { next(err); }
  },
);

// =============================================================================
// Statements (estados de cuenta) and settlement (reseller program phase 5,
// migration 008; services/resellerSettlementService.js)
// =============================================================================
// A statement closes a period of a top-level reseller's ledger; its figures
// are rebuilt from the ledger. Generating runs the commission gap sweep first.
// Org-level staff only: what a reseller owes is the ISP's record.

const STATEMENT_DATE = /^\d{4}-\d{2}-\d{2}$/;
const generateStatementSchema = {
  period_start: { type: 'string', pattern: STATEMENT_DATE },
  period_end:   { type: 'string', pattern: STATEMENT_DATE },
  notes:        { type: 'string', max: 500 },
};
const settleStatementSchema = {
  bank_ref:    { type: 'string', required: true, min: 1, max: 100 },
  record_only: { type: 'boolean' },
};

async function settlementAudit(req, action, statement, extra = {}) {
  await auditLog.log({
    userId: req.user.id,
    organizationId: req.orgId,
    action,
    tableName: 'reseller_settlements',
    recordId: statement.id,
    newValues: {
      reseller_id: statement.reseller_id,
      period_start: statement.period_start,
      period_end: statement.period_end,
      closing_balance: statement.closing_balance,
      status: statement.status,
      ...extra,
    },
  });
}

function pageOf(req, def = 25) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || def), 100);
  return { page, limit, offset: (page - 1) * limit };
}

// GET /resellers/:id/settlements
router.get('/:id/settlements', requirePermission('reseller_settlements.view'), requireIspDecision, async (req, res, next) => {
  try {
    const reseller = await getResellerOrThrow(req);
    const status = req.query.status === undefined || req.query.status === '' ? null : String(req.query.status);
    if (status !== null && !resellerSettlementService.STATUSES.includes(status)) {
      throw new ValidationError(`status must be one of ${resellerSettlementService.STATUSES.join(', ')}`);
    }
    const { page, limit, offset } = pageOf(req);
    const { rows, total } = await resellerSettlementService.list(
      req.orgId, Number(reseller.id), { statuses: status ? [status] : null, limit, offset },
    );
    res.json({ data: rows, meta: { total, page, limit, default_period: resellerSettlementService.defaultPeriod() } });
  } catch (err) { next(err); }
});

// POST /resellers/:id/settlements — generate a draft (gap sweep first)
router.post(
  '/:id/settlements',
  requirePermission('reseller_settlements.manage'),
  requireIspDecision,
  validate(generateStatementSchema),
  async (req, res, next) => {
    try {
      const reseller = await getResellerOrThrow(req);
      const notes = typeof req.body.notes === 'string' && req.body.notes.trim() ? req.body.notes.trim() : null;
      const { statement, sweep } = await resellerSettlementService.generate({
        orgId: req.orgId,
        resellerId: Number(reseller.id),
        periodStart: req.body.period_start,
        periodEnd: req.body.period_end,
        notes,
        userId: req.user.id,
      });
      await settlementAudit(req, 'reseller_statement_generate', statement);
      res.status(201).json({ data: statement, sweep });
    } catch (err) { next(err); }
  },
);

// GET /resellers/:id/settlements/:sid — the statement and a page of its lines
router.get('/:id/settlements/:sid', requirePermission('reseller_settlements.view'), requireIspDecision, async (req, res, next) => {
  try {
    const reseller = await getResellerOrThrow(req);
    const statement = await resellerSettlementService.get(req.orgId, Number(reseller.id), req.params.sid);
    const { page, limit, offset } = pageOf(req, 50);
    const { rows, total } = await resellerSettlementService.lines(req.orgId, statement, { limit, offset });
    res.json({ data: statement, lines: rows, meta: { total, page, limit } });
  } catch (err) { next(err); }
});

// GET /resellers/:id/settlements/:sid/pdf
router.get('/:id/settlements/:sid/pdf', requirePermission('reseller_settlements.view'), requireIspDecision, async (req, res, next) => {
  try {
    const reseller = await getResellerOrThrow(req);
    const statement = await resellerSettlementService.get(req.orgId, Number(reseller.id), req.params.sid);
    const { buffer, filename } = await resellerStatementPdf.generate(req.orgId, statement);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) { next(err); }
});

// POST /resellers/:id/settlements/:sid/regenerate — a draft: sweep and recompute
router.post('/:id/settlements/:sid/regenerate', requirePermission('reseller_settlements.manage'), requireIspDecision, async (req, res, next) => {
  try {
    const reseller = await getResellerOrThrow(req);
    const { statement, sweep } = await resellerSettlementService.regenerate({
      orgId: req.orgId, resellerId: Number(reseller.id), statementId: req.params.sid, userId: req.user.id,
    });
    await settlementAudit(req, 'reseller_statement_regenerate', statement);
    res.json({ data: statement, sweep });
  } catch (err) { next(err); }
});

// POST /resellers/:id/settlements/:sid/discard — a draft: void it
router.post('/:id/settlements/:sid/discard', requirePermission('reseller_settlements.manage'), requireIspDecision, async (req, res, next) => {
  try {
    const reseller = await getResellerOrThrow(req);
    const statement = await resellerSettlementService.discard({
      orgId: req.orgId, resellerId: Number(reseller.id), statementId: req.params.sid, userId: req.user.id,
    });
    await settlementAudit(req, 'reseller_statement_discard', statement);
    res.json({ data: statement });
  } catch (err) { next(err); }
});

// POST /resellers/:id/settlements/:sid/approve — freeze a draft
router.post('/:id/settlements/:sid/approve', requirePermission('reseller_settlements.approve'), requireIspDecision, async (req, res, next) => {
  try {
    const reseller = await getResellerOrThrow(req);
    const { statement, recomputed } = await resellerSettlementService.approve({
      orgId: req.orgId, resellerId: Number(reseller.id), statementId: req.params.sid, userId: req.user.id,
    });
    await settlementAudit(req, 'reseller_statement_approve', statement, { recomputed });
    res.json({ data: statement, recomputed });
  } catch (err) { next(err); }
});

// POST /resellers/:id/settlements/:sid/settle — record the transfer that squares it
router.post(
  '/:id/settlements/:sid/settle',
  requirePermission('reseller_settlements.manage'),
  requireIspDecision,
  validate(settleStatementSchema),
  async (req, res, next) => {
    try {
      const reseller = await getResellerOrThrow(req);
      const { statement, entry_id: entryId } = await resellerSettlementService.settle({
        orgId: req.orgId,
        resellerId: Number(reseller.id),
        statementId: req.params.sid,
        bankRef: req.body.bank_ref,
        recordOnly: req.body.record_only === true,
        userId: req.user.id,
      });
      await settlementAudit(req, 'reseller_statement_settle', statement, {
        bank_ref: statement.bank_ref, settlement_entry_id: entryId, record_only: req.body.record_only === true,
      });
      const summary = await resellerLedgerService.summaryFor(req.orgId, Number(reseller.id));
      res.json({ data: statement, entry_id: entryId, summary: ledgerSummary(summary) });
    } catch (err) { next(err); }
  },
);

// POST /resellers/:id/commissions/sweep — the commission gap sweep on its own
router.post('/:id/commissions/sweep', requirePermission('reseller_settlements.manage'), requireIspDecision, async (req, res, next) => {
  try {
    const reseller = await getResellerOrThrow(req);
    if (reseller.parent_id !== null && reseller.parent_id !== undefined) {
      throw new ValidationError('Commissions are booked on the top-level reseller; sweep its parent reseller');
    }
    const sweep = await resellerCommissionService.sweepCommissionGaps(req.orgId, Number(reseller.id));
    await auditLog.log({
      userId: req.user.id,
      organizationId: req.orgId,
      action: 'reseller_commission_sweep',
      tableName: 'resellers',
      recordId: Number(reseller.id),
      newValues: sweep,
    });
    res.json({ data: sweep });
  } catch (err) { next(err); }
});

// =============================================================================
// Cash bags of a reseller (reseller app phase 3, migration 005)
// =============================================================================
// Bags belong to the top-level reseller, like its ledger. Org-level staff only.

// GET /resellers/:id/bags
router.get('/:id/bags', requirePermission('cash_bags.view'), requireIspDecision, async (req, res, next) => {
  try {
    const reseller = await getResellerOrThrow(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 25), 100);
    const { rows, total, summary } = await cashBagService.resellerBagsPage(
      req.orgId, Number(reseller.id), { limit, offset: (page - 1) * limit },
    );
    res.json({ data: rows, summary, meta: { total, page, limit } });
  } catch (err) { next(err); }
});

module.exports = router;
