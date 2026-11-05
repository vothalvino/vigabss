// =============================================================================
// VigaBSS 5.0 — Speed Test Routes
// =============================================================================

const { Router } = require('express');
const SpeedTest = require('../models/SpeedTest');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createSpeedTest, updateSpeedTest } = require('../middleware/schemas/speedTests');
const db = require('../config/database');
const { rejectOrgReassignment } = require('../middleware/rejectOrgReassignment');
const { ValidationError } = require('../utils/errors');

const router = Router();
const ctrl = crudController(SpeedTest);

router.use(authenticate);
router.use(orgScope);

// Every speed test has an owner: the API stamps the caller's organization and
// commissioning the work order's.
const VISIBLE = 'st.organization_id = ?';

router.get('/', requirePermission('speed_tests.view'), async (req, res, next) => {
  try {
    const {
      client_id, contract_id, device_id, test_source, page = 1, limit = 50,
    } = req.query;
    const where = [VISIBLE, 'st.deleted_at IS NULL'];
    const params = [req.orgId];
    if (client_id) { where.push('st.client_id = ?'); params.push(client_id); }
    if (contract_id) { where.push('st.contract_id = ?'); params.push(contract_id); }
    if (device_id) { where.push('st.device_id = ?'); params.push(device_id); }
    if (test_source) { where.push('st.test_source = ?'); params.push(test_source); }

    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const clause = `WHERE ${where.join(' AND ')}`;

    const [rows] = await db.query(
      `SELECT st.*
         FROM speed_tests st ${clause}
        ORDER BY st.tested_at DESC
        LIMIT ${safeLimit} OFFSET ${(safePage - 1) * safeLimit}`,
      params,
    );
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM speed_tests st ${clause}`, params,
    );
    res.json({
      data: rows,
      meta: { total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) },
    });
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('speed_tests.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT st.*
         FROM speed_tests st WHERE st.id = ? AND st.organization_id = ? AND st.deleted_at IS NULL LIMIT 1`,
      [req.params.id, req.orgId],
    );
    if (!rows[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Speed test not found' } });
    }
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

/**
 * A speed test may only reference the caller's OWN client, contract and device.
 *
 * The foreign keys require these rows to EXIST, not to belong to anyone in
 * particular — an org-agnostic FK cannot express tenancy. So org A could post a
 * measurement against org B's contract, and crudController would stamp it
 * organization_id = A. The row is then invisible to B (their list is scoped to
 * their own org) and undeletable by them, while still being attached to their
 * contract.
 *
 * That is not merely litter. serviceHealthService.getLastSpeedTest keyed on
 * contract_id alone, so B's own service-health panel — and the context fed to
 * the AI reply assistant — would read A's forged row as B's most recent test.
 * A fabricated 0.05 Mbps with a far-future tested_at becomes B's "latest
 * measurement", which is a way to make another ISP's diagnostics lie.
 *
 * Checked here rather than in validate(): ownership is not a shape.
 */
async function assertOwnedReferences(req, res, next) {
  try {
    const checks = [
      ['client_id', 'clients'],
      ['contract_id', 'contracts'],
      ['device_id', 'devices'],
    ];
    for (const [field, table] of checks) {
      const value = req.body?.[field];
      if (value === undefined || value === null) continue;
      const [rows] = await db.query(
        `SELECT id FROM ${table}
          WHERE id = ? AND organization_id = ? AND deleted_at IS NULL LIMIT 1`,
        [value, req.orgId],
      );
      if (!rows.length) {
        throw new ValidationError(`${field} does not belong to this organization`);
      }
    }
    next();
  } catch (err) { next(err); }
}


function rejectCommissioningBinding(req, _res, next) {
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'work_order_id')) {
    return next(new ValidationError(
      'work_order_id is trusted commissioning evidence and may only be set through a work-order commissioning command',
    ));
  }
  next();
}

async function rejectBoundCommissioningMutation(req, _res, next) {
  try {
    const [rows] = await db.query(
      `SELECT st.work_order_id FROM speed_tests st
        WHERE st.id = ? AND st.organization_id = ?
        LIMIT 1`,
      [req.params.id, req.orgId],
    );
    if (rows[0]?.work_order_id) {
      throw new ValidationError(
        'Work-order commissioning evidence is immutable; record a new commissioning test instead',
      );
    }
    next();
  } catch (err) { next(err); }
}

router.post('/', requirePermission('speed_tests.create'), rejectCommissioningBinding, validate(createSpeedTest, { strip: false }), assertOwnedReferences, ctrl.create);
router.put('/:id', requirePermission('speed_tests.update'), rejectBoundCommissioningMutation, rejectOrgReassignment, validate(updateSpeedTest, { strip: false }), assertOwnedReferences, ctrl.update);
router.delete('/:id', requirePermission('speed_tests.delete'), rejectBoundCommissioningMutation, ctrl.destroy);
router.post('/:id/restore', requirePermission('speed_tests.update'), rejectBoundCommissioningMutation, ctrl.restore);

module.exports = router;
