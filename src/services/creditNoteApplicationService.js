// =============================================================================
// VigaBSS 5.0 — Credit-note applications (BIL-14)
// =============================================================================
// A credit note raised against an invoice reduces that invoice. One live
// credit_note_applications row per note records how much of it is applied:
//
//   * a posted (issued/applied) note with an invoice is applied for up to what
//     the invoice still owes, and a note applied in full turns 'applied';
//   * a draft, cancelled or deleted note, or one whose invoice is gone or no
//     longer payable, applies nothing;
//   * once the invoice is covered it turns 'paid', and back to 'issued' when a
//     released application uncovers it.
//
// The ledger is untouched here: creditNoteLedgerService already credits a
// posted note's total, and the computed balance counts only the unapplied
// part of a note as standing credit, so applied money is never counted twice.
// =============================================================================

const { creditAppliedSql } = require('../utils/invoiceBalance');

const POSTED = new Set(['issued', 'applied']);
const PAYABLE = ['issued', 'sent', 'overdue', 'paid'];

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Bring a note's live application to what its current state calls for. Runs
 * on the caller's executor (the note's transaction when there is one).
 *
 * @param {Function} exec bound query function
 * @param {object} note credit_notes row (id, invoice_id, total, status, deleted_at)
 * @param {number|null} orgId
 * @param {{release?: boolean}} [opts] release: apply nothing (the note is being
 *   deleted or cancelled in this transaction)
 * @returns {Promise<number>} the amount now applied
 */
async function syncApplication(exec, note, orgId, opts = {}) {
  const [live] = await exec(
    'SELECT id, invoice_id, amount FROM credit_note_applications WHERE credit_note_id = ? AND deleted_at IS NULL',
    [note.id],
  );
  const current = live[0] || null;

  let target = 0;
  let invoiceId = note.invoice_id || null;
  const wants = !opts.release && !note.deleted_at && POSTED.has(note.status) && invoiceId;
  if (wants) {
    // What the invoice owes apart from this note's own application.
    const [rows] = await exec(
      `SELECT i.id, i.total, i.status,
              COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                         WHERE pa.invoice_id = i.id AND pa.deleted_at IS NULL), 0)
                + ${creditAppliedSql('i')} AS covered
         FROM invoices i
        WHERE i.id = ? AND i.organization_id <=> ? AND i.client_id = ? AND i.deleted_at IS NULL
          AND i.status IN (${PAYABLE.map(() => '?').join(', ')})
        FOR UPDATE`,
      [invoiceId, orgId, note.client_id, ...PAYABLE],
    );
    const invoice = rows[0];
    if (invoice) {
      const own = current && String(current.invoice_id) === String(invoice.id) ? Number(current.amount) : 0;
      const owed = round2(Number(invoice.total) - Number(invoice.covered) + own);
      target = Math.max(0, Math.min(round2(note.total), owed));
    } else {
      invoiceId = null;
    }
  }

  const unchanged = current
    ? Math.abs(Number(current.amount) - target) < 0.005 && String(current.invoice_id) === String(invoiceId)
    : target < 0.005;
  if (!unchanged) {
    if (current) {
      await exec('UPDATE credit_note_applications SET deleted_at = NOW() WHERE id = ?', [current.id]);
    }
    if (target >= 0.005) {
      await exec(
        'INSERT INTO credit_note_applications (credit_note_id, invoice_id, amount) VALUES (?, ?, ?)',
        [note.id, invoiceId, target],
      );
    }
    for (const id of new Set([current?.invoice_id, invoiceId].filter(Boolean).map(String))) {
      await refreshPaidStatus(exec, id);
    }
  }

  // A posted note used in full is 'applied'; one with credit left is 'issued'.
  if (POSTED.has(note.status) && !opts.release && !note.deleted_at) {
    const next = target >= round2(note.total) - 0.005 && target >= 0.005 ? 'applied' : 'issued';
    if (next !== note.status) {
      await exec('UPDATE credit_notes SET status = ? WHERE id = ? AND status IN (\'issued\', \'applied\')', [next, note.id]);
    }
  }
  return target;
}

/** Release every live application against an invoice (it is voided or cancelled). */
async function releaseForInvoice(exec, invoiceId) {
  const [rows] = (await exec(
    'SELECT credit_note_id FROM credit_note_applications WHERE invoice_id = ? AND deleted_at IS NULL',
    [invoiceId],
  )) || [];
  if (!Array.isArray(rows) || rows.length === 0) return [];
  await exec('UPDATE credit_note_applications SET deleted_at = NOW() WHERE invoice_id = ? AND deleted_at IS NULL', [invoiceId]);
  // The notes keep their credit, now unapplied: back to 'issued'.
  for (const { credit_note_id: id } of rows) {
    await exec("UPDATE credit_notes SET status = 'issued' WHERE id = ? AND status = 'applied'", [id]);
  }
  return rows.map((r) => r.credit_note_id);
}

async function refreshPaidStatus(exec, invoiceId) {
  const [rows] = await exec(
    `SELECT i.total,
            COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                       WHERE pa.invoice_id = i.id AND pa.deleted_at IS NULL), 0)
              + ${creditAppliedSql('i')} AS covered
       FROM invoices i WHERE i.id = ? AND i.deleted_at IS NULL`,
    [invoiceId],
  );
  const inv = rows[0];
  if (!inv) return;
  if (Number(inv.covered) >= Number(inv.total) - 0.005) {
    await exec("UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = ? AND status IN ('issued', 'sent', 'overdue')", [invoiceId]);
  } else {
    await exec("UPDATE invoices SET status = 'issued', paid_at = NULL WHERE id = ? AND status = 'paid'", [invoiceId]);
  }
}

module.exports = { syncApplication, releaseForInvoice };
