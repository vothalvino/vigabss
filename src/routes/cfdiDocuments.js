// =============================================================================
// VigaBSS 5.0 — CFDI Document Routes
// =============================================================================

const { Router } = require('express');
const CfdiDocument = require('../models/CfdiDocument');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requireMxLocale } = require('../middleware/orgLocale');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createCfdiDocument, updateCfdiDocument, cancelCfdiDocument } = require('../middleware/schemas/cfdiDocuments');
const { AppError, NotFoundError } = require('../utils/errors');
const cfdiService = require('../services/cfdiService');
const invoiceCfdiService = require('../services/invoiceCfdiService');
const db = require('../config/database');

const router = Router();
// PUT /:id is a DRAFT-only edit (BIL-10). It used to run ctrl.update with no
// hook and no strip, and the polymorphic link ids are fillable — so a caller
// could re-point a stamped (vigente) CFDI at another invoice (any tenant's:
// assertLinkedRecordsOwned ran on POST only), then void the original invoice,
// which voidInvoiceById treats as unstamped once no CFDI names it. Now:
//   * validate(..., { strip: true }) drops every undeclared key, so the link
//     ids and amounts never reach the generic update at all;
//   * a document that is not 'draft' is filed (or being cancelled) at SAT and
//     is refused outright, under the row lock (transactionalWrites).
// The DB trigger (migrations 148 + 469) backs this up for every non-draft row.
const ctrl = crudController(CfdiDocument, {
  transactionalWrites: true,
  beforeUpdate: async (old) => {
    if (old.sat_status !== 'draft') {
      throw new AppError(
        `Only a draft CFDI can be edited (this one is ${old.sat_status}); cancel or substitute it instead.`,
        422, 'CFDI_NOT_DRAFT',
      );
    }
  },
});

router.use(authenticate);
router.use(orgScope);
router.use(requireMxLocale);

// The polymorphic source links (client_id required; invoice_id / payment_id /
// credit_note_id optional) are caller-supplied ids — without an org-ownership
// check a caller could attach a CFDI to ANOTHER org's client/invoice (422s
// as not-found instead). Runs after validate() so ids are known-numeric.
async function assertLinkedRecordsOwned(req, _res, next) {
  try {
    const checks = [
      ['clients', req.body.client_id],
      ['invoices', req.body.invoice_id],
      ['payments', req.body.payment_id],
      ['credit_notes', req.body.credit_note_id],
    ];
    for (const [table, id] of checks) {
      if (id === undefined || id === null) continue;
      const [rows] = await db.query(
        `SELECT id FROM \`${table}\` WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
        [id, req.orgId],
      );
      if (!rows[0]) {
        throw new NotFoundError(`${table.slice(0, -1)} ${id}`);
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

// An invoice CFDI is built from the invoice by POST /invoices/:id/stamp,
// which takes the row lock and derives receptor and conceptos. A bare row
// linked to an invoice froze that invoice with a hand-made draft (CFD-02).
function refuseInvoiceLink(req, _res, next) {
  if (req.body && req.body.invoice_id !== undefined && req.body.invoice_id !== null) {
    return next(new AppError(
      'An invoice CFDI is created from the invoice (POST /invoices/:id/stamp), not here.',
      422, 'CFDI_INVOICE_LINK_NOT_ALLOWED',
    ));
  }
  return next();
}

router.get('/', requirePermission('cfdi_documents.view'), ctrl.list);
router.get('/:id', requirePermission('cfdi_documents.view'), ctrl.get);
router.post('/', requirePermission('cfdi_documents.create'), refuseInvoiceLink, validate(createCfdiDocument), assertLinkedRecordsOwned, ctrl.create);
router.put('/:id', requirePermission('cfdi_documents.update'), validate(updateCfdiDocument, { strip: true }), ctrl.update);

// Discard an unstamped draft (CFD-02). Refused for stamped documents and for
// a draft whose last stamp attempt may have been registered at SAT.
router.delete('/:id', requirePermission('cfdi_documents.update'), async (req, res, next) => {
  try {
    const result = await cfdiService.discardDraft(req.params.id, req.orgId, { userId: req.user?.id ?? null });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// Rebuild an invoice's draft from the invoice as it is now: new Fecha,
// current receptor data and conceptos (CFD-02).
router.post('/:id/rebuild', requireMxLocale, requirePermission('cfdi_documents.create'), async (req, res, next) => {
  try {
    const result = await invoiceCfdiService.rebuildDraft(req.params.id, req.orgId, {
      userId: req.user?.id ?? null,
      uso_cfdi: req.body?.uso_cfdi,
      forma_pago: req.body?.forma_pago,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// Get CFDI conceptos
router.get('/:id/conceptos', requirePermission('cfdi_documents.view'), async (req, res, next) => {
  try {
    await CfdiDocument.findByIdOrFail(req.params.id, req.orgId);
    const conceptos = await CfdiDocument.getConceptos(req.params.id, req.orgId);
    res.json({ data: conceptos });
  } catch (err) {
    next(err);
  }
});

// Get related CFDI documents
router.get('/:id/related', requirePermission('cfdi_documents.view'), async (req, res, next) => {
  try {
    await CfdiDocument.findByIdOrFail(req.params.id, req.orgId);
    const related = await CfdiDocument.getRelatedDocuments(req.params.id, req.orgId);
    res.json({ data: related });
  } catch (err) {
    next(err);
  }
});

// Cancel a CFDI document
//
// This does NOT hand-roll the cancellation SQL — it delegates to
// cfdiService.cancel(), the canonical PAC → SAT cancellation flow also used by
// POST /cfdi/cancel (src/controllers/cfdiController.js). An earlier version of
// this route inserted cfdi_cancellations directly and immediately set
// sat_status='cancelado' + cancelled_at=NOW() with NO PAC/SAT submission at
// all. Per the column comments in database/schema.sql, 'cancelado' means "SAT
// confirmed cancellation" and cancelled_at means "Timestamp when SAT confirmed
// cancellation" — that write was a legally false fiscal record: SAT still held
// the CFDI as vigente while VigaBSS reported it cancelled (which would
// under-report declared income in getReconciliationReport /
// getMonthlyReport), and — because cfdiService.cancel() guards
// `sat_status !== 'vigente'` — the document became permanently
// un-cancellable through the real flow afterwards. cfdiService.cancel()
// correctly records the request as cancellation_status='pending' and sets
// sat_status='cancel_pending'; it only becomes 'cancelado' (and cancelled_at
// gets set) once the PAC/SAT response is processed (immediately if the PAC
// answers synchronously, or later via GET /cfdi/:id/cancellation-status).
router.post('/:id/cancel', requirePermission('cfdi_documents.update'), validate(cancelCfdiDocument), async (req, res, next) => {
  try {
    const { cancellation_reason, replacement_uuid } = req.body;

    // Org-scope before delegating: cfdiService.cancel() looks the document up
    // by id alone and does not itself check organization_id.
    const [docs] = await db.query(
      'SELECT id FROM cfdi_documents WHERE id = ? AND organization_id = ?',
      [req.params.id, req.orgId],
    );
    if (!docs[0]) {
      throw new NotFoundError('CFDI document');
    }

    const result = await cfdiService.cancel(req.params.id, cancellation_reason, replacement_uuid || null);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
