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
const {
  openSessionSchema, closeSessionSchema, approveSessionSchema, disputeSessionSchema,
  pickupSchema, pickupRulesSchema,
} = require('../middleware/schemas/cashReconciliation');
const cashReconciliationService = require('../services/cashReconciliationService');
const auditLog = require('../services/auditLog');

const router = Router();
const ctrl = crudController(CashReconciliationSession);

router.use(authenticate);
router.use(orgScope);

// Session rows name their owner and reviewer (agent_name, approved_by_name),
// so the page shows who a cashier belongs to instead of a user number.
function withStaffNames(handler) {
  return (req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body) => {
      res.json = send;
      if (res.statusCode >= 400 || !body || body.data === undefined) return send(body);
      cashReconciliationService.addStaffNames(body.data).then(() => send(body), next);
      return res;
    };
    return handler(req, res, next);
  };
}

// Open a new session
router.post('/sessions', requirePermission('cash_reconciliation.create'), validate(openSessionSchema, { strip: false }), async (req, res, next) => {
  try {
    const session = await cashReconciliationService.openSession({
      organizationId: req.orgId,
      agentUserId: req.user.id,
      notes: req.body.notes,
      openingTotal: req.body.opening_total,
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

// What the caller's drawer should hold when they open: the count of their
// last close, or null when there is none to compare with.
router.get('/opening', requirePermission('cash_reconciliation.create'), async (req, res, next) => {
  try {
    res.json({ data: { expected: await cashReconciliationService.openingExpectation(req.orgId, req.user.id) } });
  } catch (err) {
    next(err);
  }
});

// The organization's cashier rules. Anyone who uses the cashier reads them;
// a supervisor sets when cash should be handed in and whether that is strict.
function rulesBody(r) {
  return {
    match_tolerance: r.tolerance, max_open_hours: r.maxOpenHours,
    pickup_threshold: r.pickupThreshold, pickup_strict: r.pickupStrict,
  };
}

router.get('/rules', requirePermission('cash_reconciliation.create', 'cash_reconciliation.view'), async (req, res, next) => {
  try {
    res.json({ data: rulesBody(await cashReconciliationService.rules(req.orgId)) });
  } catch (err) {
    next(err);
  }
});

router.put('/rules', requirePermission('cash_reconciliation.approve'), validate(pickupRulesSchema, { strip: false }), async (req, res, next) => {
  try {
    const { pickup_threshold: threshold, pickup_strict: strict } = req.body;
    const saved = await cashReconciliationService.setPickupRules(req.orgId, { pickup_threshold: threshold, pickup_strict: strict });
    await auditLog.log({
      userId: req.user.id,
      organizationId: req.orgId,
      action: 'update',
      tableName: 'organization_settings',
      recordId: req.orgId,
      newValues: { cashier_pickup_threshold: saved.pickupThreshold, cashier_pickup_strict: saved.pickupStrict },
    });
    res.json({ data: rulesBody(saved) });
  } catch (err) {
    next(err);
  }
});

// A supervisor takes cash out of an open cashier; its owner confirms it.
router.post('/sessions/:id/pickups', requirePermission('cash_reconciliation.approve'), validate(pickupSchema, { strip: false }), async (req, res, next) => {
  try {
    const pickup = await cashReconciliationService.createPickup(
      req.orgId,
      parseInt(req.params.id, 10),
      { id: req.user.id, role: req.user.role },
      req.body.amount,
      req.body.note,
    );
    res.status(201).json({ data: pickup });
  } catch (err) {
    next(err);
  }
});

router.post('/pickups/:id/confirm', requirePermission('cash_reconciliation.create'), async (req, res, next) => {
  try {
    res.json({ data: await cashReconciliationService.confirmPickup(req.orgId, parseInt(req.params.id, 10), req.user.id) });
  } catch (err) {
    next(err);
  }
});

// By the cashier's owner (who rejects it) or the supervisor who recorded it.
router.post('/pickups/:id/cancel', requirePermission('cash_reconciliation.create', 'cash_reconciliation.approve'), async (req, res, next) => {
  try {
    res.json({ data: await cashReconciliationService.cancelPickup(req.orgId, parseInt(req.params.id, 10), req.user.id) });
  } catch (err) {
    next(err);
  }
});

// List sessions
router.get('/sessions', requirePermission('cash_reconciliation.view'), withStaffNames(ctrl.list));

// Get session detail with payments
router.get('/sessions/:id', requirePermission('cash_reconciliation.view'), async (req, res, next) => {
  try {
    const result = await cashReconciliationService.getSessionDetail(
      parseInt(req.params.id, 10),
      req.orgId,
    );
    // The cash supervisors took out of it, newest first.
    result.pickups = await cashReconciliationService.listPickups(req.orgId, parseInt(req.params.id, 10));
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
// Not on the reviewer's own session, unless the reviewer is the company's
// admin (the owner).
// A matching count is approved when the session is closed and never gets here.
router.post('/sessions/:id/approve', requirePermission('cash_reconciliation.approve'), validate(approveSessionSchema, { strip: false }), async (req, res, next) => {
  try {
    const session = await cashReconciliationService.approveSession(
      parseInt(req.params.id, 10),
      req.orgId,
      { id: req.user.id, role: req.user.role },
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
      { id: req.user.id, role: req.user.role },
      req.body.note,
    );
    res.json({ data: session });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
