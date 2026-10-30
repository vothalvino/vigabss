// =============================================================================
// VigaBSS 5.0 — PDF Export Routes
// =============================================================================
// Endpoints for generating and downloading PDF documents. Each route requires
// the same view permission as the document's JSON endpoint, and the generator
// binds req.orgId, so a foreign or unknown id is a 404.
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const pdfService = require('../services/pdfService');

const router = Router();

router.use(authenticate, orgScope);

/**
 * GET /api/pdf/invoices/:id
 * Download an invoice as PDF.
 */
router.get('/invoices/:id', requirePermission('invoices.view'), async (req, res, next) => {
  try {
    const locale = req.query.locale || 'en';
    const buffer = await pdfService.generateInvoicePdf(parseInt(req.params.id, 10), { locale, orgId: req.orgId });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="invoice-${req.params.id}.pdf"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/pdf/credit-notes/:id
 * Download a credit note as PDF.
 */
router.get('/credit-notes/:id', requirePermission('credit_notes.view'), async (req, res, next) => {
  try {
    const locale = req.query.locale || 'en';
    const buffer = await pdfService.generateCreditNotePdf(parseInt(req.params.id, 10), { locale, orgId: req.orgId });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="credit-note-${req.params.id}.pdf"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/pdf/quotes/:id
 * Download a quote as PDF.
 */
router.get('/quotes/:id', requirePermission('quotes.view'), async (req, res, next) => {
  try {
    const locale = req.query.locale || 'en';
    const buffer = await pdfService.generateQuotePdf(parseInt(req.params.id, 10), { locale, orgId: req.orgId });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="quote-${req.params.id}.pdf"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/pdf/cfdi/:id
 * Download a CFDI 4.0 representation as PDF.
 */
router.get('/cfdi/:id', requirePermission('cfdi_documents.view'), async (req, res, next) => {
  try {
    const locale = req.query.locale || 'en';
    const buffer = await pdfService.generateCfdiPdf(parseInt(req.params.id, 10), { locale, orgId: req.orgId });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="cfdi-${req.params.id}.pdf"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/pdf/payments/:id
 * Download a payment receipt as PDF.
 */
router.get('/payments/:id', requirePermission('payments.view'), async (req, res, next) => {
  try {
    const locale = req.query.locale || 'en';
    const buffer = await pdfService.generatePaymentReceiptPdf(parseInt(req.params.id, 10), { locale, orgId: req.orgId });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="receipt-${req.params.id}.pdf"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/pdf/clients/:id/ledger?from=YYYY-MM-DD&to=YYYY-MM-DD&locale=
 * Download a client's account statement (balance ledger) as PDF. Omit from/to
 * for an all-time statement.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
router.get('/clients/:id/ledger', requirePermission('clients.view'), async (req, res, next) => {
  try {
    const locale = req.query.locale || 'en';
    const from = ISO_DATE.test(req.query.from || '') ? req.query.from : null;
    const to = ISO_DATE.test(req.query.to || '') ? req.query.to : null;
    const buffer = await pdfService.generateClientLedgerPdf(parseInt(req.params.id, 10), {
      locale, from, to, orgId: req.orgId,
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="ledger-client-${req.params.id}.pdf"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
