// =============================================================================
// VigaBSS 5.0 — Service Area Routes
// =============================================================================

const { Router } = require('express');
const ServiceArea = require('../models/ServiceArea');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createServiceArea, updateServiceArea } = require('../middleware/schemas/serviceAreas');
const db = require('../config/database');
const auditLog = require('../services/auditLog');
const { validateGeoJsonPolygon } = require('../services/coverageZoneService');

const router = Router();
const ctrl = crudController(ServiceArea);

router.use(authenticate);
router.use(orgScope);

router.get('/', requirePermission('service_areas.view'), ctrl.list);
router.get('/:id', requirePermission('service_areas.view'), ctrl.get);
router.post('/', requirePermission('service_areas.create'), validate(createServiceArea, { strip: false }), async (req, res, next) => {
  try {
    const { name, description, boundary, color, status } = req.body;
    validateGeoJsonPolygon(boundary);
    const [result] = await db.query(
      `INSERT INTO service_areas (organization_id, name, description, boundary, color, status)
       VALUES (?, ?, ?, ST_GeomFromGeoJSON(?, 1, 4326), ?, ?)`,
      [req.orgId, name, description || null, JSON.stringify(boundary), color || null, status || 'planned'],
    );
    const area = await ServiceArea.findByIdOrFail(result.insertId, req.orgId);
    await auditLog.log({
      userId: req.user?.id, organizationId: req.orgId, action: 'create',
      tableName: 'service_areas', recordId: result.insertId, newValues: { name, status: area.status },
    });
    res.status(201).json({ data: area });
  } catch (err) { next(err); }
});

// The geometry column needs ST_GeomFromGeoJSON; the other fields go through
// the generic update.
router.put('/:id', requirePermission('service_areas.update'), validate(updateServiceArea, { strip: false }), async (req, res, next) => {
  try {
    const { boundary, ...rest } = req.body;
    if (boundary === undefined) {
      req.body = rest;
      return ctrl.update(req, res, next);
    }
    validateGeoJsonPolygon(boundary);
    await ServiceArea.findByIdOrFail(req.params.id, req.orgId);
    await db.query(
      `UPDATE service_areas SET boundary = ST_GeomFromGeoJSON(?, 1, 4326)
        WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
      [JSON.stringify(boundary), req.params.id, req.orgId],
    );
    if (!Object.keys(rest).length) {
      return res.json({ data: await ServiceArea.findByIdOrFail(req.params.id, req.orgId) });
    }
    req.body = rest;
    return ctrl.update(req, res, next);
  } catch (err) { next(err); }
});
router.delete('/:id', requirePermission('service_areas.delete'), ctrl.destroy);
router.post('/:id/restore', requirePermission('service_areas.update'), ctrl.restore);

// List coverage zones for a service area.
//
// The service_area_id arrived straight from the URL and coverage_zones was
// queried without an org predicate, so any tenant could enumerate another
// tenant's coverage polygons by guessing an id — where a competitor sells, and
// where they do not. Every sibling verb above goes through crudController and
// is scoped; only this hand-written one was not.
//
// Both halves, as elsewhere: prove the parent is the caller's, then scope the
// child query anyway.
router.get('/:id/coverage-zones', requirePermission('service_areas.view'), async (req, res, next) => {
  try {
    await ServiceArea.findByIdOrFail(req.params.id, req.orgId);
    const [rows] = await db.query(
      `SELECT * FROM coverage_zones
        WHERE service_area_id = ? AND deleted_at IS NULL
          AND (organization_id = ? OR (? IS NULL AND organization_id IS NULL))
        ORDER BY id`,
      [req.params.id, req.orgId, req.orgId],
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
