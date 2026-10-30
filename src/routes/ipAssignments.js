// =============================================================================
// VigaBSS 5.0 — IP Assignment Routes
// =============================================================================

const { Router } = require('express');
const IpAssignment = require('../models/IpAssignment');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createIpAssignment, updateIpAssignment } = require('../middleware/schemas/ipAssignments');
const provisioningService = require('../services/subscriberProvisioningService');
const db = require('../config/database');
const { ValidationError } = require('../utils/errors');

const router = Router();
const ctrl = crudController(IpAssignment);

router.use(authenticate);
router.use(orgScope);

// pool_id / contract_id / client_id / device_id reference other org-scoped
// tables, and validate() only checks their shape (client_id is fillable but
// not even declared, so it passes through unchecked). Without this a tenant
// could file an assignment against another tenant's pool, contract, client or
// device (NET-07). 422 on a foreign or missing reference.
const OWNED_REFERENCES = [
  ['pool_id', 'ip_pools'],
  ['contract_id', 'contracts'],
  ['client_id', 'clients'],
  ['device_id', 'devices'],
];

async function assertOwnedReferences(req, _res, next) {
  try {
    for (const [field, table] of OWNED_REFERENCES) {
      const value = req.body?.[field];
      if (value === undefined || value === null) continue;
      const [rows] = await db.query(
        `SELECT id FROM ${table}
          WHERE id = ? AND organization_id <=> ? AND deleted_at IS NULL LIMIT 1`,
        [value, req.orgId ?? null],
      );
      if (!rows.length) throw new ValidationError(`${field} does not belong to this organization`);
    }
    return next();
  } catch (err) { return next(err); }
}

router.get('/', requirePermission('ip_assignments.view'), ctrl.list);
router.get('/:id', requirePermission('ip_assignments.view'), ctrl.get);
router.post('/', requirePermission('ip_assignments.create'), validate(createIpAssignment), assertOwnedReferences, async (req, res, next) => {
  try {
    await provisioningService.assertIpAvailable(db, {
      ip: req.body.ip_address,
      organizationId: req.orgId,
      excludeContractId: req.body.contract_id || null,
    });
    return ctrl.create(req, res, next);
  } catch (err) { return next(err); }
});
router.put('/:id', requirePermission('ip_assignments.update'), validate(updateIpAssignment), assertOwnedReferences, async (req, res, next) => {
  try {
    if (req.body.ip_address) {
      const existing = await IpAssignment.findByIdOrFail(req.params.id, req.orgId);
      if (req.body.ip_address !== existing.ip_address) {
        await provisioningService.assertIpAvailable(db, {
          ip: req.body.ip_address,
          organizationId: req.orgId,
          excludeContractId: req.body.contract_id || existing.contract_id || null,
        });
      }
    }
    return ctrl.update(req, res, next);
  } catch (err) { return next(err); }
});
router.delete('/:id', requirePermission('ip_assignments.delete'), ctrl.destroy);
router.post('/:id/restore', requirePermission('ip_assignments.update'), ctrl.restore);

module.exports = router;
