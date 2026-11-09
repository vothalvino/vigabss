// =============================================================================
// VigaBSS 5.0 — Reseller app (Punto de Venta), phase 3: cash bags
// =============================================================================
// Mounted by routes/resellerApp.js after authenticate, orgScope,
// resellerScope and requireBoundReseller, so every route here is for a user
// bound to a reseller. Bags belong to the collecting (top-level) reseller,
// like its ledger (resellerLedgerService.collectingResellerId).
//
//  GET  /reseller-app/bags        the reseller's bags: empty, sealed, on their way
//  POST /reseller-app/bags/seal   fill an empty bag with the cash it holds
//
// The state machine and the money rules are in services/cashBagService.js.
// =============================================================================

const { Router } = require('express');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const cashBags = require('../services/cashBagService');
const ledger = require('../services/resellerLedgerService');
const Organization = require('../models/Organization');

const router = Router();

const sealSchema = {
  serial:          { type: 'string', required: true, min: 1, max: 64 },
  declared_amount: { type: 'number', required: true, min: 0.01, max: 9999999999.99 },
};

function moneySummary(summary, counts, currency) {
  return {
    currency,
    balance: summary.balance,
    in_bags: summary.in_bags,
    cash_on_hand: summary.cash_on_hand,
    credit_limit: summary.credit_limit,
    available_to_collect: summary.available_to_collect,
    limit_reached: summary.limit_reached,
    empty_bags: counts.empty,
    bags_on_the_way: counts.on_the_way,
    bags_ready_for_pickup: counts.ready_for_pickup,
    bags_in_transit: counts.in_transit,
  };
}

// =============================================================================
// GET /reseller-app/bags
// =============================================================================
router.get('/bags', requirePermission('reseller_app.bags'), async (req, res, next) => {
  try {
    const collectorId = await ledger.collectingResellerId(req);
    const [bags, summary, counts, currency] = await Promise.all([
      cashBags.resellerAppBags(req.orgId, collectorId),
      ledger.summaryFor(req.orgId, collectorId),
      ledger.bagCounts(req.orgId, collectorId),
      Organization.getCurrency(req.orgId),
    ]);
    res.json({ data: bags, summary: moneySummary(summary, counts, currency) });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /reseller-app/bags/seal
// =============================================================================
router.post('/bags/seal', requirePermission('reseller_app.bags'), validate(sealSchema), async (req, res, next) => {
  try {
    const collectorId = await ledger.collectingResellerId(req);
    const result = await cashBags.seal({
      orgId: req.orgId,
      userId: req.user.id,
      resellerId: collectorId,
      serial: req.body.serial,
      declaredAmount: req.body.declared_amount,
    });
    res.json({
      data: {
        bag: cashBags.resellerBag(result.bag),
        summary: moneySummary(result.summary, result.counts, result.bag.currency),
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
