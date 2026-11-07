// =============================================================================
// VigaBSS 5.0 — Carrier app (/ruta), reseller app phase 3
// =============================================================================
// A carrier (a user in the seeded 'carrier' group, services/carrierAccount.js)
// drops off empty cash bags at the resellers assigned to it and picks up the
// sealed ones. It never sees an amount, a client or a ledger. Every route
// answers 403 to anyone who is not a carrier; middleware/resellerFence.js
// keeps a carrier out of every other staff route.
//
//  GET  /carrier-app/me         the carrier, its bags in hand, its resellers count
//  GET  /carrier-app/resellers  its assigned resellers with bag counts
//  GET  /carrier-app/bags       its stock (with_carrier) and the bags it carries
//  POST /carrier-app/pickup     pick up a sealed bag by its serial
//  POST /carrier-app/dropoff    leave empty bags of its stock at a reseller
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { tagGuard } = require('../middleware/routeGuard');
const { isCarrierRequest } = require('../services/carrierAccount');
const carrierService = require('../services/carrierService');
const cashBags = require('../services/cashBagService');
const { ForbiddenError, NotFoundError } = require('../utils/errors');

const router = Router();
router.use(authenticate);
router.use(orgScope);

const requireCarrier = tagGuard(async (req, _res, next) => {
  try {
    if (!(await isCarrierRequest(req))) {
      return next(new ForbiddenError('Only carrier accounts can use the carrier app'));
    }
    next();
  } catch (err) { next(err); }
}, { carrier: true });
router.use(requireCarrier);

const coordinate = (max) => ({ type: 'number', min: -max, max });

const pickupSchema = {
  reseller_id: { type: 'number', required: true, min: 1 },
  serial:      { type: 'string', required: true, min: 1, max: 64 },
  latitude:    coordinate(90),
  longitude:   coordinate(180),
};

const dropoffSchema = {
  reseller_id: { type: 'number', required: true, min: 1 },
  serials:     { type: 'array', required: true },
  latitude:    coordinate(90),
  longitude:   coordinate(180),
};

const nullableNumber = (v) => (v === null || v === undefined ? null : Number(v));

// =============================================================================
// GET /carrier-app/me
// =============================================================================
router.get('/me', requirePermission('carrier_app.use'), async (req, res, next) => {
  try {
    const me = await carrierService.findCarrier(req.orgId, req.user.id);
    if (!me) throw new NotFoundError('Carrier');
    const [inHand, resellers] = await Promise.all([
      carrierService.bagsInHandFor(req.orgId, [me.id]),
      carrierService.assignedResellers(req.orgId, me.id),
    ]);
    const bags = inHand.get(Number(me.id)) || { with_carrier: 0, in_transit: 0 };
    res.json({
      data: {
        carrier: {
          user_id: Number(me.id),
          first_name: me.first_name,
          last_name: me.last_name,
          name: carrierService.fullName(me),
        },
        counts: {
          stock: bags.with_carrier,
          in_transit: bags.in_transit,
          assigned_resellers: resellers.length,
        },
      },
    });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /carrier-app/resellers
// =============================================================================
router.get('/resellers', requirePermission('carrier_app.use'), async (req, res, next) => {
  try {
    const resellers = await carrierService.assignedResellers(req.orgId, req.user.id);
    const counts = await cashBags.pickupCounts(req.orgId, resellers.map((r) => r.id));
    res.json({
      data: resellers.map((r) => ({
        id: Number(r.id),
        name: r.name,
        address: r.address ?? null,
        city: r.city ?? null,
        phone: r.phone ?? null,
        latitude: nullableNumber(r.latitude),
        longitude: nullableNumber(r.longitude),
        counts: counts.get(Number(r.id)) || { ready_for_pickup: 0, empty_bags: 0 },
      })),
    });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /carrier-app/bags
// =============================================================================
router.get('/bags', requirePermission('carrier_app.use'), async (req, res, next) => {
  try {
    res.json({ data: await cashBags.carrierAppBags(req.orgId, req.user.id) });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /carrier-app/pickup
// =============================================================================
router.post('/pickup', requirePermission('carrier_app.pickup'), validate(pickupSchema), async (req, res, next) => {
  try {
    const data = await cashBags.pickUp({
      orgId: req.orgId,
      carrierUserId: req.user.id,
      resellerId: req.body.reseller_id,
      serial: req.body.serial,
      body: req.body,
    });
    res.json({ data });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /carrier-app/dropoff
// =============================================================================
router.post('/dropoff', requirePermission('carrier_app.pickup'), validate(dropoffSchema), async (req, res, next) => {
  try {
    const data = await cashBags.dropOff({
      orgId: req.orgId,
      carrierUserId: req.user.id,
      resellerId: req.body.reseller_id,
      serials: req.body.serials,
      body: req.body,
    });
    res.json({ data });
  } catch (err) { next(err); }
});

module.exports = router;
