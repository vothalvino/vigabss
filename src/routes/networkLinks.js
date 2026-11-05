// =============================================================================
// VigaBSS 5.0 — Network Link Routes
// =============================================================================

const { Router } = require('express');
const NetworkLink = require('../models/NetworkLink');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { ownedReferences } = require('../utils/ownedReferences');
const { ValidationError } = require('../utils/errors');
const { createNetworkLink, updateNetworkLink } = require('../middleware/schemas/networkLinks');
const topologyContextService = require('../services/topologyContextService');
const logger = require('../utils/logger').child({ service: 'routes/networkLinks' });

const router = Router();
const ctrl = crudController(NetworkLink);
// Both ends of a link must be this tenant's devices (TNB-28).
const LINK_REFS = { device_a_id: 'devices', device_b_id: 'devices' };

// A link joins two different devices (chk_network_links_different_devices);
// a link from a device to itself failed the INSERT with a 500. An update that
// moves one end is compared with the stored other end.
async function rejectSelfLink(req, _res, next) {
  try {
    let { device_a_id: a, device_b_id: b } = req.body;
    if (req.params.id && (a === undefined || b === undefined)) {
      const existing = await NetworkLink.findByIdOrFail(req.params.id, req.orgId);
      a = a === undefined ? existing.device_a_id : a;
      b = b === undefined ? existing.device_b_id : b;
    }
    if (a !== undefined && a !== null && Number(a) === Number(b)) {
      throw new ValidationError('Validation failed', [{ field: 'device_b_id', message: 'device_b_id must be a different device from device_a_id' }]);
    }
    next();
  } catch (err) { next(err); }
}

router.use(authenticate);
router.use(orgScope);

router.get('/', requirePermission('network_links.view'), ctrl.list);
router.get('/:id', requirePermission('network_links.view'), ctrl.get);
router.post('/', requirePermission('network_links.create'), validate(createNetworkLink, { strip: false }), rejectSelfLink, ownedReferences(LINK_REFS), async (req, res, next) => {
  try {
    if (NetworkLink.hasOrgScope && req.orgId) req.body.organization_id = req.orgId;
    const record = await NetworkLink.create(req.body);
    topologyContextService.invalidate(record.id, 'link')
      .catch(err => logger.warn({ err: err.message, linkId: record.id }, 'topology invalidate failed on link create'));
    res.status(201).json({ data: record });
  } catch (err) { next(err); }
});
router.put('/:id', requirePermission('network_links.update'), validate(updateNetworkLink, { strip: false }), rejectSelfLink, ownedReferences(LINK_REFS), async (req, res, next) => {
  try {
    const record = await NetworkLink.update(req.params.id, req.body, req.orgId);
    topologyContextService.invalidate(record.id, 'link')
      .catch(err => logger.warn({ err: err.message, linkId: record.id }, 'topology invalidate failed on link update'));
    res.json({ data: record });
  } catch (err) { next(err); }
});
router.delete('/:id', requirePermission('network_links.delete'), async (req, res, next) => {
  try {
    const old = await NetworkLink.findByIdOrFail(req.params.id, req.orgId);
    await NetworkLink.delete(req.params.id, req.orgId);
    topologyContextService.invalidate(old.id, 'link')
      .catch(err => logger.warn({ err: err.message, linkId: old.id }, 'topology invalidate failed on link delete'));
    res.status(204).send();
  } catch (err) { next(err); }
});
router.post('/:id/restore', requirePermission('network_links.update'), async (req, res, next) => {
  try {
    const record = await NetworkLink.restore(req.params.id, req.orgId);
    topologyContextService.invalidate(record.id, 'link')
      .catch(err => logger.warn({ err: err.message, linkId: record.id }, 'topology invalidate failed on link restore'));
    res.json({ data: record });
  } catch (err) { next(err); }
});

module.exports = router;
