// =============================================================================
// VigaBSS 5.0 — Credit Note Routes
// =============================================================================

const { Router } = require('express');
const CreditNote = require('../models/CreditNote');
const Organization = require('../models/Organization');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { requireMxLocale } = require('../middleware/orgLocale');
const { validate } = require('../middleware/validate');
const { createCreditNote, updateCreditNote, createCreditNoteItem, stampCreditNote } = require('../middleware/schemas/creditNotes');
const creditNoteCfdiService = require('../services/creditNoteCfdiService');
const billingService = require('../services/billingService');
const creditNoteLedgerService = require('../services/creditNoteLedgerService');
const { AppError, NotFoundError, ValidationError } = require('../utils/errors');
const db = require('../config/database');

// Header-amounts consistency: a credit note's total drives the client balance
// (an issued note posts a client_balance_ledger credit) and the CFDI de Egreso, but the
// three amount columns were accepted unvalidated — an inconsistent note
// (subtotal + tax ≠ total) polluted the books at create and only failed later,
// at stamp time. Reject it at the door. Fires only when both subtotal and total
// are known (a total-only note, like the refund path creates, is coherent).
function assertTotalsConsistent({ subtotal, tax_amount, total }) {
  const missing = (v) => v === null || v === undefined;
  if (missing(subtotal) || missing(total)) return;
  const sub = Number(subtotal);
  const tax = Number(tax_amount ?? 0);
  const tot = Number(total);
  if ([sub, tax, tot].some(Number.isNaN)) return; // type errors are validate()'s job
  if (Math.abs(sub + tax - tot) > 0.01) {
    throw new AppError(
      `Credit note amounts are inconsistent: subtotal (${sub.toFixed(2)}) + tax (${tax.toFixed(2)}) must equal total (${tot.toFixed(2)}).`,
      422, 'CREDIT_NOTE_TOTALS_INCONSISTENT',
    );
  }
}

/**
 * A credit note whose CFDI de Egreso is live at SAT is fiscally frozen. The
 * filed XML snapshots the amounts, the receptor and the folio, so letting the
 * row drift afterwards makes it disagree with what SAT and the client both
 * hold — unfixable after the fact. Same guard invoices got in #532; the credit
 * note paths never had one.
 *
 * 'draft' counts: a draft CFDI has already snapshotted its conceptos and is
 * waiting on a stamp retry.
 */
// `exec` runs this on the caller's transaction. Under transactionalWrites a
// db.query here would acquire a SECOND pooled connection while the first is
// held — the nested-acquire hang fixed in #584 — and would also be reading
// outside the lock, which defeats the guard.
async function assertNoLiveCfdi(creditNoteId, orgId, remedy, exec = db.query) {
  const [rows] = await exec(
    `SELECT id, sat_status FROM cfdi_documents
      WHERE credit_note_id = ? AND organization_id = ?
        AND sat_status IN ('draft', 'vigente', 'cancel_pending') LIMIT 1`,
    [creditNoteId, orgId],
  );
  if (rows[0]) {
    throw new AppError(
      `This credit note has a ${rows[0].sat_status} CFDI (#${rows[0].id}) — its amounts are fiscally frozen. ${remedy}`,
      422, 'CFDI_STAMPED',
    );
  }
}

// Every field the CFDI de Egreso freezes. Compared by VALUE, not presence: the
// edit modal re-sends the amounts on every save, so a presence check would 422
// a note-text edit on any stamped credit note.
const FROZEN_FIELDS = ['subtotal', 'tax_amount', 'total', 'tax_rate', 'invoice_id', 'credit_note_number'];
function sameValue(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  const na = Number(a); const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return Math.abs(na - nb) < 0.005;
  return String(a) === String(b);
}

// ---------------------------------------------------------------------------
// Balance-ledger posting
// ---------------------------------------------------------------------------
// One invariant (src/services/creditNoteLedgerService.js): a note's net ledger
// credit equals its total while it is issued/applied and is zero while it is
// draft, cancelled or soft-deleted. Every write path below re-syncs the note to
// that target inside the transaction and row lock that changes it:
//   * draft -> issued/applied posts the final total;
//   * issued/applied -> cancelled, and soft-delete, append a reversal debit;
//   * a total change on a posted note appends the delta (the CFDI guard below
//     already freezes the amounts of a stamped note);
//   * restoring a soft-deleted posted note re-posts it.
// The sync is net-aware, so a concurrent duplicate (which waits on the row
// lock and then sees the first request's row) posts nothing.
const { POSTED_STATUSES } = creditNoteLedgerService;

/**
 * Status changes the lifecycle does not allow are refused. A posted
 * (issued/applied) note never goes back to draft — a draft is still being
 * prepared and cannot carry a credit — and a cancelled note is terminal (its
 * credit has been reversed; issue a new note instead).
 */
function assertStatusTransition(oldStatus, newStatus) {
  if (newStatus === undefined || newStatus === null || newStatus === oldStatus) return;
  if (oldStatus === 'cancelled' || (newStatus === 'draft' && oldStatus !== 'draft')) {
    throw new AppError(
      `A credit note cannot move from '${oldStatus}' to '${newStatus}'.`,
      422, 'CREDIT_NOTE_STATUS_TRANSITION',
    );
  }
}

// beforeUpdate -> afterUpdate hand-off of the locked row as it was before the
// update (its status and client decide what the ledger sync must undo).
// A credit note credits a client's account, so the client (and the invoice it
// is raised against) must belong to the caller's organization: a foreign
// client_id would post this org's credit onto another tenant's ledger.
async function assertCreditNoteFks(body, orgId, exec = db.query.bind(db)) {
  if (body.client_id !== undefined) {
    const [[client]] = body.client_id === null ? [[null]] : await exec(
      'SELECT id FROM clients WHERE id = ? AND organization_id <=> ? AND deleted_at IS NULL',
      [body.client_id, orgId],
    );
    if (!client) {
      throw new ValidationError('client_id does not belong to this organization', [
        { field: 'client_id', message: 'Invalid or cross-organization client' },
      ]);
    }
  }
  if (body.invoice_id !== undefined && body.invoice_id !== null) {
    const [[invoice]] = await exec(
      'SELECT id FROM invoices WHERE id = ? AND organization_id <=> ? AND deleted_at IS NULL',
      [body.invoice_id, orgId],
    );
    if (!invoice) {
      throw new ValidationError('invoice_id does not belong to this organization', [
        { field: 'invoice_id', message: 'Invalid or cross-organization invoice' },
      ]);
    }
  }
}

const priorRow = new WeakMap();

const router = Router();
// The update guard merges the incoming partial body over the existing row so a
// PUT that changes only one amount can't sneak the note inconsistent (or can
// deliberately FIX an inconsistent legacy note).
const ctrl = crudController(CreditNote, {
  // The guards below decide from rows a concurrent request can change — above
  // all whether a live CFDI exists. Without the lock they are advisory: a stamp
  // landing between the check and the UPDATE means the edit applies to a
  // document already filed with SAT. Credit notes had NO lock at all, so the
  // stamper was not serialized against the editor even in principle.
  transactionalWrites: true,
  // Every ledger sync (issue, cancel, total change, restore) runs inside the
  // same transaction and row lock as the change it follows, so it commits or
  // rolls back with it.
  transactionalAfterHooks: true,
  fatalAfterHooks: true,
  beforeUpdate: async (old, req, exec) => {
    assertStatusTransition(old.status, req.body.status);
    await assertCreditNoteFks(req.body, req.orgId, exec);
    priorRow.set(req, old);

    // Cancelling reverses the note's ledger credit, but a CFDI de Egreso that
    // is live at SAT still credits the client fiscally. Same guard as delete:
    // the egreso is cancelled first (POST /cfdi/cancel), then the note.
    if (req.body.status === 'cancelled' && old.status !== 'cancelled') {
      await assertNoLiveCfdi(old.id, req.orgId,
        'Cancel the CFDI at SAT before cancelling this credit note.', exec);
    }

    assertTotalsConsistent({
      subtotal: req.body.subtotal ?? old.subtotal,
      tax_amount: req.body.tax_amount ?? old.tax_amount,
      total: req.body.total ?? old.total,
    });

    const changed = FROZEN_FIELDS.filter(
      (f) => req.body[f] !== undefined && !sameValue(req.body[f], old[f]),
    );
    if (changed.length === 0) return;

    await assertNoLiveCfdi(old.id, req.orgId,
      'Cancel or substitute the CFDI before changing this credit note.', exec);

    // An edit that STRIPS the tax is the tipo-E twin of the invoice hole closed
    // in #551: a zero-tax egreso stamps ObjetoImp='01' with no impuestos, so it
    // declares the credited operation was not taxable while the ingreso it
    // relates to (TipoRelacion 01) declared tax on the same money. Fires only
    // when the edit REMOVES tax, so an already-untaxed note is never
    // re-examined and an exempt client's zero stays legal.
    const taxAmount = Number(req.body.tax_amount ?? old.tax_amount ?? 0);
    const removesTax = Number(old.tax_amount ?? 0) > 0.005 && taxAmount <= 0.005;
    if (removesTax && old.client_id) {
      // exec, not db.query: see the note on assertNoLiveCfdi above.
      await billingService.assertTaxCoherent(exec, {
        orgId: req.orgId, clientId: old.client_id, taxAmount, docType: 'credit note',
      });
    }
  },

  // Re-sync the ledger to the invariant after every update, under the row
  // lock: draft -> issued/applied posts the total, -> cancelled reverses it, a
  // total change on a posted note posts the delta, and anything else is a
  // no-op. A note re-pointed at another client first has its credit reversed
  // on the previous client, so it never stands on two accounts.
  afterUpdate: async (record, req, exec) => {
    const before = priorRow.get(req);
    if (before && before.client_id && String(before.client_id) !== String(record.client_id)) {
      await creditNoteLedgerService.syncCreditNoteLedger(exec, before, req.orgId,
        { target: 0, label: 'moved to another client' });
    }
    const label = record.status === 'cancelled' ? 'cancelled'
      : (before && POSTED_STATUSES.has(before.status) && !sameValue(before.total, record.total)
        ? 'total changed' : undefined);
    await creditNoteLedgerService.syncCreditNoteLedger(exec, record, req.orgId, { label });
  },

  // Delete and restore were as open as update was — a credit note with a live
  // CFDI could be soft-deleted while the egreso stayed filed at SAT.
  beforeDelete: async (old, req, exec) => {
    // exec, not the default: the guard must read inside the row lock, or a
    // stamp landing between the check and the soft-delete leaves a deleted note
    // whose egreso is vigente at SAT.
    await assertNoLiveCfdi(old.id, req.orgId,
      'Cancel the CFDI before deleting this credit note.', exec);
    // A soft-deleted note no longer stands on the account: reverse whatever
    // it has posted, in the same transaction as the soft-delete. The row is
    // locked, so a concurrent second delete waits, then finds no live row
    // (404) and posts nothing.
    await creditNoteLedgerService.syncCreditNoteLedger(exec, old, req.orgId,
      { target: 0, label: 'deleted' });
  },
  beforeRestore: async (req, exec) => {
    await assertNoLiveCfdi(req.params.id, req.orgId,
      'This credit note has a live CFDI; restoring it would resurrect a row that disagrees with the filed document.', exec);
  },
  // Restoring an issued/applied note puts its credit back on the account
  // (a restored draft or cancelled note stays at zero). Runs on the restore
  // transaction, after its UPDATE has locked the row.
  afterRestore: async (record, req, exec) => {
    await creditNoteLedgerService.syncCreditNoteLedger(exec, record, req.orgId, { label: 'restored' });
  },
});

router.use(authenticate);
router.use(orgScope);

/**
 * Attach each row's CFDI state to a page of credit notes.
 *
 * The list returned unaliased credit_notes columns and nothing else, so the UI
 * had no way to know a note was already stamped — it kept offering Stamp, and
 * the click came back 409. The same statuses assertNoLiveCfdi treats as live
 * count here, so the button disappears exactly when the stamp route would
 * refuse: `cfdi_sat_status` is null when there is no live CFDI.
 *
 * One query for the whole page, and the placeholders are built by hand —
 * `IN (?)` does NOT expand to a list under this execute-backed db.query, it
 * binds the array as a single value and silently matches nothing.
 */
async function attachCfdiState(orgId, rows) {
  const ids = rows.map(r => r.id).filter(id => id !== null && id !== undefined);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  const [cfdis] = await db.query(
    `SELECT credit_note_id, id, uuid, sat_status FROM cfdi_documents
      WHERE organization_id = ? AND credit_note_id IN (${placeholders})
        AND sat_status IN ('draft', 'vigente', 'cancel_pending')`,
    [orgId, ...ids],
  );
  const byNote = new Map();
  for (const c of cfdis) byNote.set(String(c.credit_note_id), c);
  for (const row of rows) {
    const c = byNote.get(String(row.id)) || null;
    row.cfdi_document_id = c ? c.id : null;
    row.cfdi_uuid = c ? c.uuid : null;
    row.cfdi_sat_status = c ? c.sat_status : null;
  }
}

router.get('/', requirePermission('credit_notes.view'), (req, res, next) => {
  // ctrl.list owns the filtering, pagination and org scoping; intercept its
  // payload rather than reimplementing all of that for one extra field.
  const sendJson = res.json.bind(res);
  res.json = (payload) => {
    const rows = Array.isArray(payload?.data) ? payload.data : null;
    if (!rows || rows.length === 0) return sendJson(payload);
    attachCfdiState(req.orgId, rows).then(() => sendJson(payload)).catch(next);
    return res;
  };
  return ctrl.list(req, res, next);
});
router.get('/:id', requirePermission('credit_notes.view'), ctrl.get);
router.post('/', requirePermission('credit_notes.create'), validate(createCreditNote), async (req, res, next) => {
  try {
    assertTotalsConsistent(req.body);
    await assertCreditNoteFks(req.body, req.orgId);
    req.body.organization_id = req.orgId;

    // The resolver was never consulted here. A credit note for a non-exempt MX
    // client with tax 0 satisfied the consistency check above (1160 + 0 = 1160)
    // and stamped as a tipo-E CFDI with ObjetoImp='01' and no impuestos —
    // telling SAT the credited operation was not taxable, while the ingreso it
    // relates to declared IVA on the same money. Both directions, same helper
    // the invoice and quote paths use.
    await billingService.assertTaxCoherent(db.query.bind(db), {
      orgId: req.orgId,
      clientId: req.body.client_id,
      taxAmount: req.body.tax_amount ?? 0,
      docType: 'credit note',
    });
    // Default currency when the caller omits one: prefer the linked
    // invoice's own currency (a credit note against an invoice should be
    // denominated the same way that invoice is), otherwise the org's
    // currency — never a hardcoded 'USD'. An explicitly-set currency in the
    // request always wins.
    if (!req.body.currency) {
      let invoiceCurrency = null;
      if (req.body.invoice_id) {
        const [[invoiceRow]] = await db.query(
          'SELECT currency FROM invoices WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
          [req.body.invoice_id, req.orgId],
        );
        invoiceCurrency = invoiceRow?.currency || null;
      }
      req.body.currency = invoiceCurrency || await Organization.getCurrency(req.orgId);
    }
    const creditNote = await CreditNote.create(req.body);

    // Credit the client balance ledger only for a note created already
    // issued/applied. A draft (the default) posts at its issue transition.
    if (POSTED_STATUSES.has(creditNote.status)) {
      await creditNoteLedgerService.syncCreditNoteLedger(db.query.bind(db), creditNote, req.orgId);
    }

    res.status(201).json({ data: creditNote });
  } catch (err) {
    next(err);
  }
});
router.put('/:id', requirePermission('credit_notes.update'), validate(updateCreditNote), ctrl.update);
router.delete('/:id', requirePermission('credit_notes.delete'), ctrl.destroy);
router.post('/:id/restore', requirePermission('credit_notes.update'), ctrl.restore);

// Stamp as CFDI de Egreso: convert this credit note into a tipo-E CFDI related
// (TipoRelacion 01) to the credited invoice's vigente CFDI and submit it to the
// org's PAC. MX-locale orgs only; permission mirrors direct CFDI creation. The
// service enforces every fiscal precondition (org+client MX profiles, stampable
// status, a vigente related ingreso, single-CFDI-per-credit-note) with
// actionable 4xx errors.
router.post('/:id/stamp', requireMxLocale, requirePermission('cfdi_documents.create'), validate(stampCreditNote), async (req, res, next) => {
  try {
    const result = await creditNoteCfdiService.stampCreditNote(req.params.id, req.orgId, {
      uso_cfdi: req.body.uso_cfdi,
      forma_pago: req.body.forma_pago,
      userId: req.user?.id,
    });
    // Always 200: the conversion itself succeeded. `stamped: false` +
    // `stamp_error` reports a retryable PAC failure (doc stays 'draft').
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// Credit note line items. credit_note_items has no organization_id, so both
// routes prove the parent credit note belongs to the caller's org first (404
// otherwise). They used to read and write by id alone, and POST spread the
// body AFTER the URL id, so a body credit_note_id chose the parent outright.
router.get('/:id/items', requirePermission('credit_notes.view'), async (req, res, next) => {
  try {
    await CreditNote.findByIdOrFail(req.params.id, req.orgId);
    const items = await CreditNote.getItems(req.params.id, req.orgId);
    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/items', requirePermission('credit_notes.update'), validate(createCreditNoteItem), async (req, res, next) => {
  try {
    const conn = await db.getConnection();
    let item;
    try {
      await conn.beginTransaction();
      const exec = conn.execute.bind(conn);
      // Lock the parent so a concurrent stamp/issue cannot land between the
      // guards below and the insert.
      const [[note]] = await exec(
        `SELECT id, status, tax_rate FROM credit_notes
          WHERE id = ? AND organization_id = ? AND deleted_at IS NULL FOR UPDATE`,
        [req.params.id, req.orgId],
      );
      if (!note) throw new NotFoundError('Credit note');
      // Lines can only be added while the note is still being prepared: an
      // issued/applied note has already credited the client's balance, and a
      // cancelled one is void.
      if (note.status !== 'draft') {
        throw new AppError(
          `Line items can only be added to a draft credit note (this one is ${note.status}).`,
          422, 'CREDIT_NOTE_NOT_DRAFT',
        );
      }
      await assertNoLiveCfdi(note.id, req.orgId,
        'Cancel or substitute the CFDI before adding line items.', exec);
      // Only the URL id names the parent; any body credit_note_id is ignored.
      const { credit_note_id: _ignored, ...line } = req.body;
      item = await CreditNote.addItem({ ...line, credit_note_id: note.id }, req.orgId, exec);
      // Header follows the line, in the same transaction: the line's STORED
      // total (quantity * unit_price, a generated column), never body.amount.
      // Drafts post nothing to the ledger, so nothing else moves.
      await billingService.applyCreditNoteLineItemToTotals(exec, note.id, note.tax_rate, item.total);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.status(201).json({ data: item });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
