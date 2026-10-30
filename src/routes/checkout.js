// =============================================================================
// VigaBSS 5.0 — Checkout / Payment Flow Routes
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const checkoutSchemas = require('../middleware/schemas/checkout');
const checkoutService = require('../services/checkoutService');

const router = Router();
router.use(authenticate);
router.use(orgScope);

// POST /api/checkout/session — Create a checkout session for an invoice
router.post('/session', requirePermission('payments.create'), validate(checkoutSchemas.createSession), async (req, res, next) => {
  try {
    const data = await checkoutService.createCheckoutSession({
      organizationId: req.orgId,
      invoiceId: req.body.invoice_id,
      clientId: req.body.client_id,
      returnUrl: req.body.return_url,
    });
    res.status(201).json({ data });
  } catch (err) { next(err); }
});

// POST /api/checkout/payment-link — Generate a payment link
router.post('/payment-link', requirePermission('payments.create'), validate(checkoutSchemas.createPaymentLink), async (req, res, next) => {
  try {
    const data = await checkoutService.generatePaymentLink({
      organizationId: req.orgId,
      invoiceId: req.body.invoice_id,
    });
    res.status(201).json({ data });
  } catch (err) { next(err); }
});

// Recurring-profile charges run only from the scheduler
// (checkoutService.processRecurringCharges). There is deliberately no HTTP
// route: the former POST /checkout/recurring/:id/charge loaded the profile by
// id without an organization check and charged the stored card again on every
// call.

module.exports = router;
