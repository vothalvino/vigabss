// =============================================================================
// VigaBSS 5.0 — Money tie-out routes
// =============================================================================
// The month's collections tied to the bank, the organization's bank accounts
// and the safe (services/moneyTieOutService.js). All of it is for whoever
// supervises the cash: cash_reconciliation.approve.
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const {
  createBankAccountSchema, updateBankAccountSchema, safeMovementSchema,
} = require('../middleware/schemas/moneyTieOut');
const moneyTieOutService = require('../services/moneyTieOutService');
const auditLog = require('../services/auditLog');
const { businessToday } = require('../utils/businessDate');

const router = Router();
router.use(authenticate);
router.use(orgScope);

const supervisor = requirePermission('cash_reconciliation.approve');

function yearMonth(req) {
  const today = businessToday();
  return {
    year: req.query.year === undefined ? Number(today.slice(0, 4)) : Number(req.query.year),
    month: req.query.month === undefined ? Number(today.slice(5, 7)) : Number(req.query.month),
  };
}

router.get('/', supervisor, async (req, res, next) => {
  try {
    const { year, month } = yearMonth(req);
    res.json({ data: await moneyTieOutService.report(req.orgId, year, month) });
  } catch (err) { next(err); }
});

router.get('/bank-accounts', supervisor, async (req, res, next) => {
  try {
    res.json({ data: await moneyTieOutService.listBankAccounts(req.orgId) });
  } catch (err) { next(err); }
});

router.post('/bank-accounts', supervisor, validate(createBankAccountSchema), async (req, res, next) => {
  try {
    const account = await moneyTieOutService.createBankAccount(req.orgId, req.user.id, req.body);
    await auditLog.log({
      userId: req.user.id, organizationId: req.orgId, action: 'create',
      tableName: 'bank_accounts', recordId: account.id, newValues: account,
    });
    res.status(201).json({ data: account });
  } catch (err) { next(err); }
});

router.put('/bank-accounts/:id', supervisor, validate(updateBankAccountSchema), async (req, res, next) => {
  try {
    const account = await moneyTieOutService.updateBankAccount(req.orgId, parseInt(req.params.id, 10), req.body);
    await auditLog.log({
      userId: req.user.id, organizationId: req.orgId, action: 'update',
      tableName: 'bank_accounts', recordId: account.id, newValues: account,
    });
    res.json({ data: account });
  } catch (err) { next(err); }
});

router.get('/safe-movements', supervisor, async (req, res, next) => {
  try {
    const { year, month } = yearMonth(req);
    const range = moneyTieOutService.monthRange(year, month);
    res.json({ data: await moneyTieOutService.listSafeMovements(req.orgId, range) });
  } catch (err) { next(err); }
});

router.post('/safe-movements', supervisor, validate(safeMovementSchema), async (req, res, next) => {
  try {
    const movement = await moneyTieOutService.recordSafeMovement(req.orgId, req.user.id, req.body);
    await auditLog.log({
      userId: req.user.id, organizationId: req.orgId, action: 'create',
      tableName: 'cash_safe_movements', recordId: movement.id, newValues: movement,
    });
    res.status(201).json({ data: movement });
  } catch (err) { next(err); }
});

router.delete('/safe-movements/:id', supervisor, async (req, res, next) => {
  try {
    const removed = await moneyTieOutService.removeSafeMovement(req.orgId, parseInt(req.params.id, 10));
    await auditLog.log({
      userId: req.user.id, organizationId: req.orgId, action: 'delete',
      tableName: 'cash_safe_movements', recordId: removed.id, oldValues: removed,
    });
    res.json({ data: removed });
  } catch (err) { next(err); }
});

module.exports = router;
