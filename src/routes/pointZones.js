// =============================================================================
// VigaBSS 5.0 — Zones of resellers and collectors
// =============================================================================
// Reading the zones needs cash_bags.view or resellers.view (the cash bags
// page filters by them); changing them or a point's zone needs
// resellers.update.
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { zoneSchema, assignZoneSchema } = require('../middleware/schemas/pointZones');
const pointZoneService = require('../services/pointZoneService');
const auditLog = require('../services/auditLog');

const router = Router();
router.use(authenticate);
router.use(orgScope);

const read = requirePermission('cash_bags.view', 'resellers.view');
const write = requirePermission('resellers.update');
const audit = (req, action, tableName, recordId, values) => auditLog.log({
  userId: req.user.id, organizationId: req.orgId, action, tableName, recordId,
  ...(action === 'delete' ? { oldValues: values } : { newValues: values }),
});

router.get('/', read, async (req, res, next) => {
  try { res.json({ data: await pointZoneService.list(req.orgId) }); } catch (err) { next(err); }
});

// The points and the zone each is in. Before '/:id'.
router.get('/points', read, async (req, res, next) => {
  try { res.json({ data: await pointZoneService.points(req.orgId) }); } catch (err) { next(err); }
});

router.put('/points/:resellerId', write, validate(assignZoneSchema), async (req, res, next) => {
  try {
    const zoneId = req.body.zone_id === undefined || req.body.zone_id === null ? null : Number(req.body.zone_id);
    const out = await pointZoneService.assign(req.orgId, parseInt(req.params.resellerId, 10), zoneId);
    await audit(req, 'update', 'resellers', out.reseller_id, { zone_id: out.zone_id });
    res.json({ data: out });
  } catch (err) { next(err); }
});

router.post('/', write, validate(zoneSchema), async (req, res, next) => {
  try {
    const zone = await pointZoneService.create(req.orgId, req.user.id, req.body);
    await audit(req, 'create', 'point_zones', zone.id, zone);
    res.status(201).json({ data: zone });
  } catch (err) { next(err); }
});

router.put('/:id', write, validate(zoneSchema), async (req, res, next) => {
  try {
    const zone = await pointZoneService.rename(req.orgId, parseInt(req.params.id, 10), req.body);
    await audit(req, 'update', 'point_zones', zone.id, zone);
    res.json({ data: zone });
  } catch (err) { next(err); }
});

router.delete('/:id', write, async (req, res, next) => {
  try {
    const zone = await pointZoneService.remove(req.orgId, parseInt(req.params.id, 10));
    await audit(req, 'delete', 'point_zones', zone.id, zone);
    res.json({ data: zone });
  } catch (err) { next(err); }
});

module.exports = router;
