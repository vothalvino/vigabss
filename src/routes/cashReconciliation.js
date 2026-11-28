// =============================================================================
// VigaBSS 5.0 — Cash Reconciliation Routes
// =============================================================================

const { Router } = require('express');
const CashReconciliationSession = require('../models/CashReconciliationSession');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission, userHasPermission } = require('../middleware/rbac');
const { NotFoundError, AppError } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const {
  openSessionSchema, closeSessionSchema, approveSessionSchema, disputeSessionSchema,
  pickupSchema, pickupRulesSchema, userLimitSchema,
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

// Who sees what (owner decisions, 2026-11-27):
//   - the company's admin sees everyone's cashiers and their whole history;
//   - a supervisor (cash_reconciliation.approve) sees one line per person, each
//     person's open cashier, and the counts that did not match and are not
//     settled, which is what a supervisor acts on;
//   - anyone else sees the same of their own cashiers only.
// Nobody but the admin reads settled history, their own included: a list of
// past counts is an easy way to add up everything a person has taken in.
// "Admin" is the same test the review rules below already use.
const isCompanyAdmin = (req) => req.user.role === 'admin';
const isSupervisor = (req) => userHasPermission(req, 'cash_reconciliation.approve');
const SUPERVISOR_STATUSES = ['open', 'closed', 'disputed'];
const ANY_CASHIER_PERMISSION = ['cash_reconciliation.create', 'cash_reconciliation.view', 'cash_reconciliation.approve'];

// One line per person: what their drawer holds and whether it needs a look.
// Before '/sessions/:id' and the other parameter routes.
router.get('/staff', requirePermission(...ANY_CASHIER_PERMISSION), async (req, res, next) => {
  try {
    const everyone = isCompanyAdmin(req) || await isSupervisor(req);
    res.json({
      data: await cashReconciliationService.staffOverview(req.orgId, everyone ? {} : { onlyUserId: req.user.id }),
      meta: { scope: everyone ? 'everyone' : 'own' },
    });
  } catch (err) {
    next(err);
  }
});

// One person's cashiers. Someone who may not see this person gets the same
// 404 as for a person with no cashier.
router.get('/staff/:userId', requirePermission(...ANY_CASHIER_PERMISSION), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(userId) || userId < 1) throw new NotFoundError('cash_reconciliation_sessions');
    const own = userId === Number(req.user.id);
    const admin = isCompanyAdmin(req);
    if (!own && !admin && !await isSupervisor(req)) throw new NotFoundError('cash_reconciliation_sessions');
    res.json({ data: await cashReconciliationService.staffDetail(req.orgId, userId, { full: admin }) });
  } catch (err) {
    next(err);
  }
});

// A supervisor sets one person's cash limit and whether it is strict, or
// puts them back on the organization's setting. Never their own, except the
// company's admin: the limit is a control on the person, not theirs to set.
async function limitTarget(req) {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId) || userId < 1) throw new NotFoundError('cash_reconciliation_sessions');
  if (userId === Number(req.user.id) && !isCompanyAdmin(req)) {
    throw new AppError('Your own cash limit is set by another supervisor.', 403, 'OWN_CASHIER');
  }
  // Only a person who has a cashier in this organization (404 otherwise).
  const [person] = await cashReconciliationService.staffOverview(req.orgId, { onlyUserId: userId });
  if (!person) throw new NotFoundError('cash_reconciliation_sessions');
  return userId;
}
const limitBody = (limit) => ({ pickup_threshold: limit.pickupThreshold, pickup_strict: limit.pickupStrict, own: limit.own });

router.put('/staff/:userId/limit', requirePermission('cash_reconciliation.approve'), validate(userLimitSchema), async (req, res, next) => {
  try {
    const userId = await limitTarget(req);
    const saved = await cashReconciliationService.setUserLimit(req.orgId, userId, req.body, req.user.id);
    await auditLog.log({
      userId: req.user.id, organizationId: req.orgId, action: 'update',
      tableName: 'cashier_user_limits', recordId: userId, newValues: limitBody(saved),
    });
    res.json({ data: limitBody(saved) });
  } catch (err) {
    next(err);
  }
});

router.delete('/staff/:userId/limit', requirePermission('cash_reconciliation.approve'), async (req, res, next) => {
  try {
    const userId = await limitTarget(req);
    const now = await cashReconciliationService.clearUserLimit(req.orgId, userId);
    await auditLog.log({
      userId: req.user.id, organizationId: req.orgId, action: 'delete',
      tableName: 'cashier_user_limits', recordId: userId, newValues: limitBody(now),
    });
    res.json({ data: limitBody(now) });
  } catch (err) {
    next(err);
  }
});

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

// List sessions: every cashier for the company's admin. Anyone else gets their
// own open cashier and their counts not yet settled, as on their own page.
async function ownOpenSessionsUnlessAdmin(req, res, next) {
  if (isCompanyAdmin(req)) return next();
  try {
    let sessions = [];
    try {
      ({ sessions } = await cashReconciliationService.staffDetail(req.orgId, Number(req.user.id), { full: false }));
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err; // no cashier yet: an empty list
    }
    return res.json({ data: sessions, meta: { total: sessions.length, page: 1, limit: sessions.length, totalPages: 1 } });
  } catch (err) {
    return next(err);
  }
}
router.get('/sessions', requirePermission('cash_reconciliation.view'), ownOpenSessionsUnlessAdmin, withStaffNames(ctrl.list));

// Get session detail with payments
router.get('/sessions/:id', requirePermission(...ANY_CASHIER_PERMISSION), async (req, res, next) => {
  try {
    const result = await cashReconciliationService.getSessionDetail(
      parseInt(req.params.id, 10),
      req.orgId,
    );
    // The same 404 as a missing session for one the caller may not see.
    const session = result.session || {};
    const own = Number(session.agent_user_id) === Number(req.user.id);
    if (!isCompanyAdmin(req)
        && !(SUPERVISOR_STATUSES.includes(session.status) && (own || await isSupervisor(req)))) {
      throw new NotFoundError('cash_reconciliation_sessions');
    }
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
