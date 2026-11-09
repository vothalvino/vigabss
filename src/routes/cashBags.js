// =============================================================================
// VigaBSS 5.0 — Cash bags, staff side (reseller app phase 3, migration 005)
// =============================================================================
// The ISP registers numbered money bags, hands them to carriers, and counts
// and receives the sealed bags carriers bring in (services/cashBagService.js).
//
//  GET  /cash-bags                  a page of bags (status, reseller, carrier, serial filters)
//  GET  /cash-bags/summary          counts per status, cash in bags, per-reseller differences
//  GET  /cash-bags/:id              one bag with its history
//  POST /cash-bags                  register one serial or a range
//  POST /cash-bags/handover         hand bags in stock to a carrier for a point
//  POST /cash-bags/assign           give bags in stock straight to a point (no carrier)
//  POST /cash-bags/:id/receive      count a bag and post its deposit
//  POST /cash-bags/:id/void         take a bag without money out of use
//  POST /cash-bags/:id/lost         a bag with money in it is lost
//  POST /cash-bags/:id/return       carrier stock back to stock, or an empty bag back to the carrier
//                                   (or to stock, when no carrier ever had it)
//
// Org-level staff only: a reseller-bound user or a carrier is refused here
// whatever its group holds (the fence refuses them first).
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { resellerScope } = require('../middleware/resellerScope');
const { isCarrierRequest } = require('../services/carrierAccount');
const cashBags = require('../services/cashBagService');
const { ForbiddenError, ValidationError } = require('../utils/errors');

const router = Router();
router.use(authenticate);
router.use(orgScope);
router.use(resellerScope);

/**
 * Cash bags are the ISP's records: refused to reseller-bound users and to
 * carriers, whatever permissions their group holds.
 */
async function requireOrgStaff(req, _res, next) {
  try {
    if (!req.resellerScope || !req.resellerScope.all) {
      return next(new ForbiddenError('Only the ISP can manage cash bags'));
    }
    if (await isCarrierRequest(req)) return next(new ForbiddenError('Carrier accounts can only use the carrier app'));
    next();
  } catch (err) { next(err); }
}
router.use(requireOrgStaff);

function pagination(query, defaultLimit = 25) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || defaultLimit), 100);
  return { page, limit, offset: (page - 1) * limit };
}

const registerSchema = {
  serial: { type: 'string', min: 1, max: 64 },
  prefix: { type: 'string', max: 40 },
  from:   { type: 'number', min: 0, max: 999999999999 },
  to:     { type: 'number', min: 0, max: 999999999999 },
  pad:    { type: 'number', min: 0, max: 12 },
  notes:  { type: 'string', max: 500 },
};

const handoverSchema = {
  carrier_user_id: { type: 'number', required: true, min: 1 },
  reseller_id:     { type: 'number', required: true, min: 1 },
  serials:         { type: 'array' },
  bag_ids:         { type: 'array' },
};

const assignSchema = {
  reseller_id: { type: 'number', required: true, min: 1 },
  serials:     { type: 'array' },
  bag_ids:     { type: 'array' },
};

const receiveSchema = {
  counted_amount: { type: 'number', required: true, min: 0, max: 9999999999.99 },
  note:           { type: 'string', max: 400 },
};

const reasonSchema = {
  reason: { type: 'string', required: true, min: 3, max: 500 },
};

const returnSchema = {
  reason:          { type: 'string', max: 500 },
  carrier_user_id: { type: 'number', min: 1 },
};

function requireReason(body) {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3) throw new ValidationError('reason must be at least 3 characters');
  return reason;
}

// =============================================================================
// GET /cash-bags
// =============================================================================
router.get('/', requirePermission('cash_bags.view'), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query);
    const { rows, total } = await cashBags.listBags(req.orgId, req.query, { limit, offset });
    res.json({ data: rows, meta: { total, page, limit } });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /cash-bags/summary
// =============================================================================
router.get('/summary', requirePermission('cash_bags.view'), async (req, res, next) => {
  try {
    res.json({ data: await cashBags.summary(req.orgId) });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /cash-bags
// =============================================================================
router.post('/', requirePermission('cash_bags.manage'), validate(registerSchema), async (req, res, next) => {
  try {
    const result = await cashBags.registerBags({ orgId: req.orgId, userId: req.user.id, body: req.body });
    res.status(201).json({ data: result });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /cash-bags/handover
// =============================================================================
router.post('/handover', requirePermission('cash_bags.manage'), validate(handoverSchema), async (req, res, next) => {
  try {
    const { serials, bag_ids: bagIds } = req.body;
    if ((serials === undefined) === (bagIds === undefined)) {
      throw new ValidationError('Send serials or bag_ids (one of them)');
    }
    const data = await cashBags.handOver({
      orgId: req.orgId, userId: req.user.id, carrierUserId: req.body.carrier_user_id, resellerId: req.body.reseller_id, serials, bagIds,
    });
    res.json({ data });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /cash-bags/assign — straight to a point, no carrier
// =============================================================================
router.post('/assign', requirePermission('cash_bags.manage'), validate(assignSchema), async (req, res, next) => {
  try {
    const { serials, bag_ids: bagIds } = req.body;
    if ((serials === undefined) === (bagIds === undefined)) {
      throw new ValidationError('Send serials or bag_ids (one of them)');
    }
    const data = await cashBags.assignToPoint({
      orgId: req.orgId, userId: req.user.id, resellerId: req.body.reseller_id, serials, bagIds,
    });
    res.json({ data });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /cash-bags/:id
// =============================================================================
router.get('/:id', requirePermission('cash_bags.view'), async (req, res, next) => {
  try {
    res.json({ data: await cashBags.getBag(req.orgId, req.params.id) });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /cash-bags/:id/receive
// =============================================================================
router.post('/:id/receive', requirePermission('cash_bags.receive'), validate(receiveSchema), async (req, res, next) => {
  try {
    const result = await cashBags.receive({
      orgId: req.orgId, userId: req.user.id, bagId: req.params.id,
      countedAmount: req.body.counted_amount, note: req.body.note,
    });
    const [bag] = await cashBags.staffBags(req.orgId, [result.bag]);
    res.json({
      data: {
        bag,
        ledger_entries: result.entries,
        summary: {
          balance: result.summary.balance,
          in_bags: result.summary.in_bags,
          cash_on_hand: result.summary.cash_on_hand,
          credit_limit: result.summary.credit_limit,
          available_to_collect: result.summary.available_to_collect,
          credit_limit_override: result.summary.credit_limit_override,
        },
      },
    });
  } catch (err) { next(err); }
});

async function respondBag(req, res, row) {
  const [bag] = await cashBags.staffBags(req.orgId, [row]);
  res.json({ data: bag });
}

// =============================================================================
// POST /cash-bags/:id/void
// =============================================================================
router.post('/:id/void', requirePermission('cash_bags.manage'), validate(reasonSchema), async (req, res, next) => {
  try {
    const row = await cashBags.voidBag({ orgId: req.orgId, userId: req.user.id, bagId: req.params.id, reason: requireReason(req.body) });
    await respondBag(req, res, row);
  } catch (err) { next(err); }
});

// =============================================================================
// POST /cash-bags/:id/lost
// =============================================================================
router.post('/:id/lost', requirePermission('cash_bags.manage'), validate(reasonSchema), async (req, res, next) => {
  try {
    const row = await cashBags.markLost({ orgId: req.orgId, userId: req.user.id, bagId: req.params.id, reason: requireReason(req.body) });
    await respondBag(req, res, row);
  } catch (err) { next(err); }
});

// =============================================================================
// POST /cash-bags/:id/return
// =============================================================================
router.post('/:id/return', requirePermission('cash_bags.manage'), validate(returnSchema), async (req, res, next) => {
  try {
    const row = await cashBags.returnBag({
      orgId: req.orgId, userId: req.user.id, bagId: req.params.id,
      reason: req.body.reason, carrierUserId: req.body.carrier_user_id ?? null,
    });
    await respondBag(req, res, row);
  } catch (err) { next(err); }
});

module.exports = router;
