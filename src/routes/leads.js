// =============================================================================
// VigaBSS 5.0 — Lead Routes (prospect pipeline) — §1.2
// =============================================================================

const { Router } = require('express');
const Lead = require('../models/Lead');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { rejectOrgReassignment } = require('../middleware/rejectOrgReassignment');
const { createLead, updateLead, patchLead, convertLead, geocodeLead } = require('../middleware/schemas/leads');
const lifecycleService = require('../services/lifecycleService');
const leadFeasibilityService = require('../services/leadFeasibilityService');
const auditLog = require('../services/auditLog');
const db = require('../config/database');
const { inPlaceholders } = require('../utils/sqlBuild');

const router = Router();
// The sales agent must be a user of this organization.
const ctrl = crudController(Lead, { cacheResource: 'leads', ownedRefs: { assigned_to: 'users' } });

router.use(authenticate);
router.use(orgScope);

// Lead rows carry reseller_id (migration 003); the list and detail add the
// reseller's name. The join binds the reseller to the lead's organization.
async function addResellerNames(data, orgId) {
  const rows = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
  const ids = [...new Set(rows.map((r) => r.reseller_id).filter((id) => id !== null && id !== undefined).map(Number))];
  const names = new Map();
  if (ids.length) {
    const [found] = await db.query(
      /* includes deleted rows: a lead keeps the name of the reseller that captured it */
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

// Run a crudController handler and add reseller names to the `data` it sends.
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

// List leads, with an optional free-text `search` (partial name/email/phone/
// company, exact numeric id) for the create-service-order lead picker. Falls
// through to the generic crudController list — unchanged, zero regression
// risk — whenever `search` is absent, so callers relying on order_by/order/
// filters/pagination keep their existing behaviour exactly.
router.get('/', requirePermission('leads.view'), async (req, res, next) => {
  const term = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  if (!term) return withResellerNames(ctrl.list)(req, res, next);

  try {
    const { page = 1, limit = 50 } = req.query;
    const conditions = [];
    const params = [];
    if (Lead.hasOrgScope && req.orgId) {
      conditions.push('organization_id = ?');
      params.push(req.orgId);
    }
    conditions.push('deleted_at IS NULL');
    if (req.query.reseller_id !== undefined && req.query.reseller_id !== '') {
      conditions.push('reseller_id = ?');
      params.push(req.query.reseller_id);
    }
    // Partial match on name/email/phone/company; exact match on the numeric id
    // — mirrors routes/clients.js's search handler.
    conditions.push('(name LIKE ? OR email LIKE ? OR phone LIKE ? OR company LIKE ? OR CAST(id AS CHAR) = ?)');
    params.push(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`, term);

    const where = `WHERE ${conditions.join(' AND ')}`;
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeOffset = (safePage - 1) * safeLimit;

    const [rows] = await db.query(
      `SELECT * FROM leads ${where} ORDER BY id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params,
    );
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM leads ${where}`,
      params,
    );

    await addResellerNames(rows, req.orgId);
    res.json({
      data: rows,
      meta: { total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) },
    });
  } catch (err) { next(err); }
});

// Pipeline stage counts — must precede '/:id'
router.get('/pipeline', requirePermission('leads.view'), async (req, res, next) => {
  try {
    const counts = await Lead.pipelineCounts(req.orgId);
    res.json({ data: counts });
  } catch (err) { next(err); }
});

// Desk feasibility check: coverage-zone hit + nearest AP sectors + nearest
// active ODF frames for the lead's coordinates. Read-only; reuses leads.view.
router.get('/:id/feasibility', requirePermission('leads.view'), async (req, res, next) => {
  try {
    const result = await leadFeasibilityService.assess(req.params.id, req.orgId);
    res.json({ data: result });
  } catch (err) { next(err); }
});

// Geocode the lead's address into coordinates — feasibility's only input.
// Mirrors POST /clients/:id/geocode (leads carry no country/geocoded_at).
router.post('/:id/geocode', requirePermission('leads.update'), validate(geocodeLead, { strip: false }), async (req, res, next) => {
  try {
    const lead = await Lead.findById(req.params.id, req.orgId);
    if (!lead) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
    const { geocodeAddress } = require('../services/geocodingService');
    const source = {
      address: req.body.address ?? lead.address,
      city: req.body.city ?? lead.city,
      state: req.body.state ?? lead.state,
      zip_code: req.body.zip_code ?? lead.zip_code,
    };
    const result = await geocodeAddress(source);
    const updated = await Lead.update(
      req.params.id,
      { latitude: result.latitude, longitude: result.longitude },
      req.orgId,
    );
    res.json({ data: updated, geocode: result });
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('leads.view'), withResellerNames(ctrl.get));
router.post('/', requirePermission('leads.create'), validate(createLead, { strip: false }), ctrl.create);
router.put('/:id', requirePermission('leads.update'), rejectOrgReassignment, validate(updateLead, { strip: true }), ctrl.update);
router.patch('/:id', requirePermission('leads.update'), rejectOrgReassignment, validate(patchLead, { strip: true }), ctrl.partialUpdate);
router.delete('/:id', requirePermission('leads.delete'), ctrl.destroy);
router.post('/:id/restore', requirePermission('leads.update'), ctrl.restore);

// Convert a lead into a client (creates the client, marks the lead won)
router.post('/:id/convert', requirePermission('clients.create'), validate(convertLead, { strip: false }), async (req, res, next) => {
  try {
    const result = await lifecycleService.convertLead(req.params.id, req.orgId, req.body || {});
    await auditLog.log({
      userId: req.user?.id,
      organizationId: req.orgId,
      action: 'convert',
      tableName: 'leads',
      recordId: parseInt(req.params.id, 10),
      newValues: { converted_client_id: result.client.id },
    }).catch(() => {});
    res.status(201).json({ data: result });
  } catch (err) { next(err); }
});

module.exports = router;
