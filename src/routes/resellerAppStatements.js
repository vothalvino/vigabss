// =============================================================================
// VigaBSS 5.0 — Reseller app (Punto de Venta), phase 5: statements
// =============================================================================
// Mounted by routes/resellerApp.js after authenticate, orgScope,
// resellerScope and requireBoundReseller, so every route here is for a user
// bound to a reseller. Statements belong to the collecting (top-level)
// reseller, like its ledger; a sub-reseller login sees its parent's, as Mi
// caja shows it the parent's ledger. Only approved and settled statements:
// a draft is the ISP's work in progress.
//
//  GET /reseller-app/statements           the reseller's statements
//  GET /reseller-app/statements/:sid      one, with a page of its lines
//  GET /reseller-app/statements/:sid/pdf  its PDF
// =============================================================================

const { Router } = require('express');
const { requirePermission } = require('../middleware/rbac');
const { NotFoundError } = require('../utils/errors');
const ledger = require('../services/resellerLedgerService');
const settlements = require('../services/resellerSettlementService');
const statementPdf = require('../services/resellerStatementPdf');

const router = Router();
const VISIBLE = ['approved', 'settled'];

// The fields of a ledger line the reseller sees, as GET /reseller-app/ledger.
const appLine = ({
  id, entry_type: entryType, amount, note, created_at: createdAt, payment_id: paymentId,
  cash_bag_serial: cashBagSerial, invoice_number: invoiceNumber,
}) => ({
  id, entry_type: entryType, amount, note, created_at: createdAt, payment_id: paymentId,
  cash_bag_serial: cashBagSerial, invoice_number: invoiceNumber,
});

function pageOf(req, def) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || def), 100);
  return { page, limit, offset: (page - 1) * limit };
}

/** The statement, or a 404 when it is not the reseller's or not yet approved. */
async function visibleStatement(req) {
  const collectorId = await ledger.collectingResellerId(req);
  const statement = await settlements.get(req.orgId, collectorId, req.params.sid);
  if (!VISIBLE.includes(statement.status)) throw new NotFoundError('Statement');
  return statement;
}

// GET /reseller-app/statements
router.get('/statements', requirePermission('reseller_app.statements'), async (req, res, next) => {
  try {
    const collectorId = await ledger.collectingResellerId(req);
    const { page, limit, offset } = pageOf(req, 12);
    const { rows, total } = await settlements.list(req.orgId, collectorId, { statuses: VISIBLE, limit, offset });
    res.json({ data: rows, meta: { total, page, limit } });
  } catch (err) { next(err); }
});

// GET /reseller-app/statements/:sid
router.get('/statements/:sid', requirePermission('reseller_app.statements'), async (req, res, next) => {
  try {
    const statement = await visibleStatement(req);
    const { page, limit, offset } = pageOf(req, 50);
    const { rows, total } = await settlements.lines(req.orgId, statement, { limit, offset });
    res.json({ data: statement, lines: rows.map(appLine), meta: { total, page, limit } });
  } catch (err) { next(err); }
});

// GET /reseller-app/statements/:sid/pdf
router.get('/statements/:sid/pdf', requirePermission('reseller_app.statements'), async (req, res, next) => {
  try {
    const statement = await visibleStatement(req);
    const { buffer, filename } = await statementPdf.generate(req.orgId, statement);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) { next(err); }
});

module.exports = router;
