// =============================================================================
// VigaBSS 5.0 — Reseller app (Punto de Venta), phase 2: cash collection
// =============================================================================
// Mounted by routes/resellerApp.js after authenticate, orgScope,
// resellerScope and requireBoundReseller, so every route here is for a user
// bound to a reseller. The collecting reseller, which holds the cash ledger,
// is the top-level reseller of the binding (resellerLedgerService
// .collectingResellerId): a sub-reseller's users collect for its parent.
//
//  GET  /reseller-app/collect/lookup?q=        find any subscriber by exact number or phone
//  GET  /reseller-app/collect/client/:id       an own client, ready to collect from
//  POST /reseller-app/payments                 collect cash (Idempotency-Key header)
//  GET  /reseller-app/payments?date=           the reseller's collections of a day
//  GET  /reseller-app/payments/:id/receipt     receipt of one of them
//  POST /reseller-app/payments/:id/void        void a same-day collection
//  GET  /reseller-app/cash-session             the user's open cash box and last closes
//  POST /reseller-app/cash-session/close       close it with the counted cash
//  GET  /reseller-app/ledger                   the reseller's cash ledger and summary
//
// The money logic is in services/resellerCollectionService.js and
// services/resellerLedgerService.js.
// =============================================================================

const { Router } = require('express');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { resellerLookupLimiter } = require('../middleware/rateLimit');
const collection = require('../services/resellerCollectionService');
const ledger = require('../services/resellerLedgerService');

const router = Router();

function pagination(query, defaultLimit = 25) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || defaultLimit), 100);
  return { page, limit, offset: (page - 1) * limit };
}

const collectSchema = {
  collect_token:     { type: 'string', required: true, min: 1, max: 512 },
  amount:            { type: 'number', required: true, min: 0.01, max: 99999999.99 },
  invoice_ids:       { type: 'array' },
  note:              { type: 'string', max: 500 },
  client_request_id: { type: 'string', min: 8, max: 128 },
};

const voidSchema = {
  reason: { type: 'string', required: true, min: 3, max: 200 },
};

const closeSessionSchema = {
  counted_total: { type: 'number', required: true, min: 0, max: 9999999999.99 },
  notes:         { type: 'string', max: 1000 },
};

// =============================================================================
// GET /reseller-app/collect/lookup
// =============================================================================
// The lookup budget is per collecting (top-level) reseller, shared by its
// sub-resellers' logins.
async function resolveCollector(req, _res, next) {
  try {
    req.collectingResellerId = await ledger.collectingResellerId(req);
    next();
  } catch (err) { next(err); }
}

router.get('/collect/lookup', requirePermission('reseller_app.collect'), resolveCollector, resellerLookupLimiter, async (req, res, next) => {
  try {
    res.json({ data: await collection.lookup(req, req.query.q) });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /reseller-app/collect/client/:id
// =============================================================================
router.get('/collect/client/:id', requirePermission('reseller_app.collect'), async (req, res, next) => {
  try {
    res.json({ data: await collection.targetForOwnClient(req, req.params.id) });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /reseller-app/payments
// =============================================================================
router.post('/payments', requirePermission('reseller_app.collect'), validate(collectSchema), async (req, res, next) => {
  try {
    const key = req.get('Idempotency-Key') || req.body.client_request_id || null;
    const result = await collection.collect(req, req.body, key);
    if (result.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  } catch (err) {
    if (err && err.code === 'CREDIT_LIMIT') {
      return res.status(409).json({
        error: {
          code: 'CREDIT_LIMIT',
          message: err.message,
          available_to_collect: err.extra.available_to_collect,
          // Empty bags the reseller may fill to free its limit (phase 3).
          empty_bags: err.extra.empty_bags,
          details: err.extra,
          ...(req.id ? { requestId: req.id } : {}),
        },
      });
    }
    next(err);
  }
});

// =============================================================================
// GET /reseller-app/payments
// =============================================================================
router.get('/payments', requirePermission('reseller_app.use'), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query);
    const date = typeof req.query.date === 'string' && req.query.date !== '' ? req.query.date : null;
    const { data, meta } = await collection.listCollections(req, { date, limit, offset });
    res.json({ data, meta: { ...meta, page, limit } });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /reseller-app/payments/:id/receipt
// =============================================================================
router.get('/payments/:id/receipt', requirePermission('reseller_app.use'), async (req, res, next) => {
  try {
    const width = req.query.width === '80' ? 48 : 32;
    res.json({ data: await collection.receipt(req, req.params.id, { width }) });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /reseller-app/payments/:id/void
// =============================================================================
router.post('/payments/:id/void', requirePermission('reseller_app.collect'), validate(voidSchema), async (req, res, next) => {
  try {
    const reason = req.body.reason.trim();
    if (reason.length < 3) {
      return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'reason must be at least 3 characters' } });
    }
    res.json({ data: await collection.voidCollection(req, req.params.id, reason) });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /reseller-app/cash-session
// =============================================================================
router.get('/cash-session', requirePermission('reseller_app.use'), async (req, res, next) => {
  try {
    res.json({ data: await collection.cashSession(req) });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /reseller-app/cash-session/close
// =============================================================================
router.post('/cash-session/close', requirePermission('reseller_app.collect'), validate(closeSessionSchema), async (req, res, next) => {
  try {
    res.json({ data: await collection.closeCashSession(req, req.body) });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /reseller-app/ledger
// =============================================================================
router.get('/ledger', requirePermission('reseller_app.use'), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query);
    const collectorId = await ledger.collectingResellerId(req);
    const [{ rows, total }, summary] = await Promise.all([
      ledger.listEntries(req.orgId, collectorId, { limit, offset }),
      ledger.summaryFor(req.orgId, collectorId),
    ]);
    res.json({
      // invoice_number names the invoice of a commission line (phase 4).
      data: rows.map(({
        id, entry_type: entryType, amount, note, created_at: createdAt, payment_id: paymentId,
        cash_bag_serial: cashBagSerial, invoice_number: invoiceNumber,
      }) => ({
        id, entry_type: entryType, amount, note, created_at: createdAt, payment_id: paymentId,
        cash_bag_serial: cashBagSerial, invoice_number: invoiceNumber,
      })),
      summary: {
        balance: summary.balance,
        in_bags: summary.in_bags,
        cash_on_hand: summary.cash_on_hand,
        credit_limit: summary.credit_limit,
        available_to_collect: summary.available_to_collect,
        limit_reached: summary.limit_reached,
      },
      meta: { total, page, limit },
    });
  } catch (err) { next(err); }
});

module.exports = router;
