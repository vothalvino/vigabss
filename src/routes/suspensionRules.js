// =============================================================================
// VigaBSS 5.0 — Suspension Rule Routes
// =============================================================================

const { Router } = require('express');
const SuspensionRule = require('../models/SuspensionRule');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createSuspensionRule, updateSuspensionRule } = require('../middleware/schemas/suspensionRules');
const db = require('../config/database');
const { ValidationError } = require('../utils/errors');

const router = Router();

// apply_to_plan_ids limits a rule to some plans (BIL-11). Every id must be a
// live plan of the caller's organization, and the list is stored as JSON
// (mysql2 would otherwise expand an array into a bare "1, 2" list).
async function normalizePlanScope(req, _res, next) {
  try {
    const ids = req.body?.apply_to_plan_ids;
    if (ids === undefined || ids === null) return next();
    if (!ids.every(id => Number.isSafeInteger(id) && id > 0)) {
      throw new ValidationError('Validation failed', [
        { field: 'apply_to_plan_ids', message: 'apply_to_plan_ids must be a list of plan ids' },
      ]);
    }
    const unique = [...new Set(ids)];
    if (unique.length) {
      const [[{ n }]] = await db.query(
        `SELECT COUNT(*) AS n FROM plans
          WHERE id IN (${unique.map(() => '?').join(', ')})
            AND organization_id <=> ? AND deleted_at IS NULL`,
        [...unique, req.orgId],
      );
      if (Number(n) !== unique.length) {
        throw new ValidationError('Validation failed', [
          { field: 'apply_to_plan_ids', message: 'Every plan must belong to this organization' },
        ]);
      }
    }
    req.body.apply_to_plan_ids = JSON.stringify(unique);
    return next();
  } catch (err) {
    return next(err);
  }
}
const ctrl = crudController(SuspensionRule);

router.use(authenticate);
router.use(orgScope);

router.get('/', requirePermission('suspension_rules.view'), ctrl.list);
router.get('/:id', requirePermission('suspension_rules.view'), ctrl.get);
router.post('/', requirePermission('suspension_rules.create'), validate(createSuspensionRule), normalizePlanScope, ctrl.create);
router.put('/:id', requirePermission('suspension_rules.update'), validate(updateSuspensionRule), normalizePlanScope, ctrl.update);
router.delete('/:id', requirePermission('suspension_rules.delete'), ctrl.destroy);
router.post('/:id/restore', requirePermission('suspension_rules.update'), ctrl.restore);

module.exports = router;
