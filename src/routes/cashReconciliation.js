// =============================================================================
// VigaBSS 5.0 — Cash Reconciliation Routes
// =============================================================================

const { Router } = require('express');
const CashReconciliationSession = require('../models/CashReconciliationSession');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { openSessionSchema, closeSessionSchema, approveSessionSchema, disputeSessionSchema } = require('../middleware/schemas/cashReconciliation');
const cashReconciliationService = require('../services/cashReconciliationService');

const router = Router();
const ctrl = crudController(CashReconciliationSession);

router.use(authenticate);
router.use(orgScope);

// Open a new session
router.post('/sessions', requirePermission('cash_reconciliation.create'), validate(openSessionSchema, { strip: false }), async (req, res, next) => {
  try {
    const session = await cashReconciliationService.openSession({
      organizationId: req.orgId,
      agentUserId: req.user.id,
      notes: req.body.notes,
    });
    res.status(201).json({ data: session });
  } catch (err) {
    next(err);
  }
});

// The caller's own open cashier, for the reminder shown on every page.
router.get('/my-cashier', requirePermission('cash_reconciliation.create', 'cash_reconciliation.view'), async (req, res, next) => {
  try {
    res.json({ data: await cashReconciliationService.myOpenSession(req.orgId, req.user.id) });
  } catch (err) {
    next(err);
  }
});

// What a supervisor should look at: cashiers open too long, counts to review.
router.get('/attention', requirePermission('cash_reconciliation.approve'), async (req, res, next) => {
  try {
    res.json({ data: await cashReconciliationService.attention(req.orgId) });
  } catch (err) {
    next(err);
  }
});

// List sessions
router.get('/sessions', requirePermission('cash_reconciliation.view'), ctrl.list);

// Get session detail with payments
router.get('/sessions/:id', requirePermission('cash_reconciliation.view'), async (req, res, next) => {
  try {
    const result = await cashReconciliationService.getSessionDetail(
      parseInt(req.params.id, 10),
      req.orgId,
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// Close session
router.post('/sessions/:id/close', requirePermission('cash_reconciliation.update'), validate(closeSessionSchema, { strip: false }), async (req, res, next) => {
  try {
    const session = await cashReconciliationService.closeSession(
      parseInt(req.params.id, 10),
      req.orgId,
      req.body.counted_total,
    );
    res.json({ data: session });
  } catch (err) {
    next(err);
  }
});

// A supervisor's decision on a closed session whose count did not match.
// A matching count is approved when the session is closed and never gets here.
router.post('/sessions/:id/approve', requirePermission('cash_reconciliation.approve'), validate(approveSessionSchema, { strip: false }), async (req, res, next) => {
  try {
    const session = await cashReconciliationService.approveSession(
      parseInt(req.params.id, 10),
      req.orgId,
      req.user.id,
      req.body.note,
    );
    res.json({ data: session });
  } catch (err) {
    next(err);
  }
});

router.post('/sessions/:id/dispute', requirePermission('cash_reconciliation.approve'), validate(disputeSessionSchema, { strip: false }), async (req, res, next) => {
  try {
    const session = await cashReconciliationService.disputeSession(
      parseInt(req.params.id, 10),
      req.orgId,
      req.user.id,
      req.body.note,
    );
    res.json({ data: session });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
