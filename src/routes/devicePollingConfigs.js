// =============================================================================
// VigaBSS 5.0 — Device Polling Config Routes (§6.4)
// =============================================================================
//
// GET    /device-polling-configs              — list (polling_configs.view)
// POST   /device-polling-configs              — create (polling_configs.create)
// GET    /device-polling-configs/:id          — get by id (polling_configs.view)
// PUT    /device-polling-configs/:id          — update (polling_configs.update)
// DELETE /device-polling-configs/:id          — delete (polling_configs.delete)
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { crudController } = require('../controllers/crudController');
const DevicePollingConfig = require('../models/DevicePollingConfig');
const { createDevicePollingConfig, updateDevicePollingConfig } = require('../middleware/schemas/devicePollingConfigs');
const db = require('../config/database');
const { ValidationError } = require('../utils/errors');

const router = Router();
router.use(authenticate);
router.use(orgScope);

const ctrl = crudController(DevicePollingConfig);

// A device-specific override must name a device of the caller's organization
// (TNA-18). validate() only checks the shape, so a foreign device_id was stored
// and the install-wide poller applied it to the other tenant's device. The
// poller now also ignores cross-org rows; this rejects them at the edge (422).
async function assertOwnedDevice(req, _res, next) {
  try {
    const deviceId = req.body?.device_id;
    if (deviceId === undefined || deviceId === null) return next();
    const [rows] = await db.query(
      `SELECT id FROM devices
        WHERE id = ? AND organization_id <=> ? AND deleted_at IS NULL LIMIT 1`,
      [deviceId, req.orgId ?? null],
    );
    if (!rows.length) {
      throw new ValidationError('device_id does not belong to this organization');
    }
    return next();
  } catch (err) { return next(err); }
}

router.get('/',     requirePermission('polling_configs.view'),   ctrl.list);
router.get('/:id',  requirePermission('polling_configs.view'),   ctrl.get);
router.post('/',    requirePermission('polling_configs.create'),  validate(createDevicePollingConfig), assertOwnedDevice, ctrl.create);
router.put('/:id',  requirePermission('polling_configs.update'),  validate(updateDevicePollingConfig), assertOwnedDevice, ctrl.update);
router.delete('/:id', requirePermission('polling_configs.delete'), ctrl.destroy);

module.exports = router;
