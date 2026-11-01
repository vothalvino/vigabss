// =============================================================================
// VigaBSS 5.0 — Expense Routes
// =============================================================================

const { Router } = require('express');
const Expense = require('../models/Expense');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createExpense, updateExpense } = require('../middleware/schemas/expenses');
const db = require('../config/database');
const auditLog = require('../services/auditLog');
const { NotFoundError, ValidationError, ForbiddenError } = require('../utils/errors');

const router = Router();
const ctrl = crudController(Expense);

router.use(authenticate);
router.use(orgScope);

router.get('/', requirePermission('expenses.view'), ctrl.list);
router.get('/:id', requirePermission('expenses.view'), ctrl.get);
// Approval is its own step (TNA-28): the creator and editors set neither the
// status nor whose expense it is, so an expense cannot be filed as approved
// or charged to someone else. Only POST /:id/approve and /:id/reject change
// the status, under expenses.approve.
const APPROVAL_FIELDS = ['status', 'user_id', 'approved_by'];
function stripApprovalFields(req) {
  for (const f of APPROVAL_FIELDS) delete req.body[f];
}

router.post('/', requirePermission('expenses.create'), validate(createExpense), (req, res, next) => {
  stripApprovalFields(req);
  // The incurring employee is the logged-in staff member (expenses.user_id is NOT NULL).
  req.body.user_id = req.user.id;
  req.body.status = 'pending';
  return ctrl.create(req, res, next);
});
router.put('/:id', requirePermission('expenses.update'), validate(updateExpense), (req, res, next) => {
  stripApprovalFields(req);
  return ctrl.update(req, res, next);
});

function decide(status) {
  return async (req, res, next) => {
    try {
      const [[expense]] = await db.query(
        'SELECT id, user_id, status FROM expenses WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
        [req.params.id, req.orgId],
      );
      if (!expense) throw new NotFoundError('Expense');
      if (expense.status !== 'pending') throw new ValidationError(`Only a pending expense can be ${status}`);
      if (Number(expense.user_id) === Number(req.user.id)) {
        throw new ForbiddenError(`You cannot mark your own expense ${status}`);
      }
      const [result] = await db.query(
        "UPDATE expenses SET status = ?, approved_by = ? WHERE id = ? AND organization_id = ? AND status = 'pending' AND deleted_at IS NULL",
        [status, req.user.id, req.params.id, req.orgId],
      );
      if (!result.affectedRows) throw new ValidationError(`Only a pending expense can be ${status}`);
      await auditLog.log({
        userId: req.user.id, organizationId: req.orgId, action: 'update', tableName: 'expenses', recordId: expense.id,
        oldValues: { status: 'pending' }, newValues: { status, approved_by: req.user.id },
      });
      const [[row]] = await db.query('SELECT * FROM expenses WHERE id = ? AND organization_id = ?', [req.params.id, req.orgId]);
      res.json({ data: row });
    } catch (err) { next(err); }
  };
}

router.post('/:id/approve', requirePermission('expenses.approve'), decide('approved'));
router.post('/:id/reject', requirePermission('expenses.approve'), decide('rejected'));
router.delete('/:id', requirePermission('expenses.delete'), ctrl.destroy);
router.post('/:id/restore', requirePermission('expenses.update'), ctrl.restore);

module.exports = router;
