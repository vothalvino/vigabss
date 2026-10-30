// =============================================================================
// VigaBSS 5.0 — Refund Request Service
// =============================================================================
// Manages the refund request lifecycle: create → review → process.
// Emits `refund.requested` and `refund.processed` events.
// =============================================================================

const db = require('../config/database');
const RefundRequest = require('../models/RefundRequest');
const eventBus = require('./eventBus');
const billingAdjustmentService = require('./billingAdjustmentService');
const { ValidationError, NotFoundError } = require('../utils/errors');
const logger = require('../utils/logger').child({ service: 'refundRequest' });
const paymentGatewayService = require('./paymentGatewayService');
const billingService = require('./billingService');
const Organization = require('../models/Organization');

// ---------------------------------------------------------------------------
// Reference ownership
// ---------------------------------------------------------------------------

/**
 * Verify that the client, invoice and payment transaction a refund request
 * points at all belong to the caller's organization (and the invoice and
 * transaction to that client). Without this, a request could name another
 * tenant's gateway charge and processing would refund it.
 */
async function assertReferencesOwned(orgId, { client_id, invoice_id, payment_id }) {
  const [clients] = await db.query(
    'SELECT id FROM clients WHERE id = ? AND organization_id <=> ? AND deleted_at IS NULL LIMIT 1',
    [client_id, orgId],
  );
  if (!clients[0]) throw new ValidationError('client_id does not reference a client in this organization');

  if (invoice_id) {
    const [invoices] = await db.query(
      `SELECT id FROM invoices
        WHERE id = ? AND organization_id <=> ? AND client_id = ? AND deleted_at IS NULL LIMIT 1`,
      [invoice_id, orgId, client_id],
    );
    if (!invoices[0]) throw new ValidationError('invoice_id does not reference an invoice of this client');
  }

  if (payment_id) {
    const [txs] = await db.query(
      'SELECT id FROM payment_transactions WHERE id = ? AND organization_id <=> ? AND client_id = ? LIMIT 1',
      [payment_id, orgId, client_id],
    );
    if (!txs[0]) throw new ValidationError('payment_id does not reference a payment transaction of this client');
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a new refund request and emit `refund.requested`.
 *
 * @param {number|null} orgId
 * @param {object} data  - Validated request body
 * @param {number} requestedByUserId
 * @returns {Promise<object>} The new refund_requests row
 */
async function createRequest(orgId, data, requestedByUserId) {
  await assertReferencesOwned(orgId, data);
  const refundRequest = await RefundRequest.create({
    organization_id: orgId || null,
    client_id: data.client_id,
    payment_id: data.payment_id || null,
    invoice_id: data.invoice_id || null,
    amount: data.amount,
    reason: data.reason,
    status: 'requested',
    requested_by: requestedByUserId || null,
  });

  logger.info({ refundRequestId: refundRequest.id, orgId }, 'Refund request created');

  eventBus.emit('refund.requested', {
    organizationId: orgId,
    refundRequest,
  });

  return refundRequest;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

const EDITABLE_FIELDS = ['amount', 'reason', 'payment_id', 'invoice_id'];

/**
 * Edit an open refund request. Only the request fields are editable (never
 * status, reviewer or processing fields), only before review, and any new
 * invoice or payment reference must belong to the request's client.
 *
 * @param {number|null} orgId
 * @param {number} id
 * @param {object} data  - Validated, stripped request body
 * @returns {Promise<object>} Updated row
 */
async function updateRequest(orgId, id, data) {
  const existing = await RefundRequest.findByIdOrFail(id, orgId);
  if (!['requested', 'under_review'].includes(existing.status)) {
    throw new ValidationError(
      `Cannot edit a refund request with status '${existing.status}'. Must be 'requested' or 'under_review'.`,
    );
  }

  const changes = {};
  for (const field of EDITABLE_FIELDS) {
    if (data[field] !== undefined) changes[field] = data[field];
  }

  await assertReferencesOwned(orgId, {
    client_id: existing.client_id,
    invoice_id: changes.invoice_id !== undefined ? changes.invoice_id : existing.invoice_id,
    payment_id: changes.payment_id !== undefined ? changes.payment_id : existing.payment_id,
  });

  return RefundRequest.update(id, changes, orgId);
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * Approve or reject a refund request.
 *
 * @param {number|null} orgId
 * @param {number} id
 * @param {object} params
 * @param {string} params.status        - 'approved' or 'rejected'
 * @param {string} [params.review_notes]
 * @param {number} reviewedByUserId
 * @returns {Promise<object>} Updated row
 */
async function reviewRequest(orgId, id, { status, review_notes }, reviewedByUserId) {
  const existing = await RefundRequest.findByIdOrFail(id, orgId);

  if (!['requested', 'under_review'].includes(existing.status)) {
    throw new ValidationError(
      `Cannot review a refund request with status '${existing.status}'. Must be 'requested' or 'under_review'.`,
    );
  }

  if (!['approved', 'rejected'].includes(status)) {
    throw new ValidationError("Review status must be 'approved' or 'rejected'.");
  }

  const updated = await RefundRequest.update(id, {
    status,
    reviewed_by: reviewedByUserId || null,
    review_notes: review_notes || null,
  }, orgId);

  logger.info({ refundRequestId: id, status, orgId }, 'Refund request reviewed');

  return updated;
}

// ---------------------------------------------------------------------------
// Refund credit-note tax
// ---------------------------------------------------------------------------

/**
 * Decompose a refund's GROSS amount into the subtotal/tax a credit note must
 * carry, at the tax rate of the thing being refunded.
 *
 * refund_requests.amount is what the subscriber actually gets back, so it is
 * tax-inclusive: a full refund of a 1160 invoice (1000 + 16% IVA) is 1160.
 * Writing that as subtotal 1160 / tax 0 — which is what this service did —
 * stamps a CFDI de Egreso declaring the credited operation was not taxable,
 * while the ingreso it relates to (TipoRelacion 01) declared IVA on the same
 * money. The two documents then contradict each other at SAT.
 *
 * The rate comes from the ORIGINAL INVOICE when there is one: that is the rate
 * the money was actually taxed at, and it can legitimately differ from what the
 * client would be charged today (an 8%-frontera invoice credited after the org
 * moved to 16%, or a rate change between issue and refund). Only when the
 * refund is not tied to an invoice do we fall back to resolving the client's
 * current context — same resolver the credit-note route uses.
 *
 * @param {number|null} orgId
 * @param {{ amount: number|string, invoice_id: number|null, client_id: number }} refund
 * @returns {Promise<{subtotal: number, taxAmount: number, taxRate: number, currency: string}>}
 */
async function resolveRefundCreditNoteTax(orgId, refund) {
  const gross = Math.round((parseFloat(refund.amount) || 0) * 100) / 100;
  let rate = 0;
  let currency = null;

  if (refund.invoice_id) {
    const [rows] = await db.query(
      `SELECT tax_rate, currency FROM invoices
        WHERE id = ? AND (organization_id = ? OR (? IS NULL AND organization_id IS NULL))
          AND deleted_at IS NULL LIMIT 1`,
      [refund.invoice_id, orgId, orgId],
    );
    if (rows[0]) {
      rate = billingService.invoiceTaxFraction(rows[0].tax_rate);
      currency = rows[0].currency || null;
    }
  }

  if (!refund.invoice_id) {
    const ctx = await billingService.resolveTaxContext(db.query.bind(db), {
      orgId, clientId: refund.client_id,
    });
    rate = billingService.invoiceTaxFraction(ctx.rate);
  }

  if (!currency) currency = await Organization.getCurrency(orgId);

  // Tax-INCLUSIVE decomposition, and the subtotal is derived from the tax so
  // subtotal + tax === gross exactly. Deriving both independently lets a
  // half-cent land in the gap, and credit_notes.total is checked against
  // subtotal + tax_amount at create and at stamp time.
  const taxAmount = Math.round((gross - gross / (1 + rate)) * 100) / 100;
  const subtotal = Math.round((gross - taxAmount) * 100) / 100;
  return { subtotal, taxAmount, taxRate: rate, currency };
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

/**
 * Process an approved refund request.
 *
 * When refund_method='credit_balance': inserts into client_balance_ledger and
 * optionally marks the payment_transaction as refunded.
 * When refund_method='credit_note': creates a credit_note row.
 * Always records a billing_adjustment.
 * Emits `refund.processed`.
 *
 * @param {number|null} orgId
 * @param {number} id
 * @param {object} params
 * @param {string} params.refund_method
 * @param {string} [params.gateway_refund_reference]
 * @param {number} processedByUserId
 * @returns {Promise<object>} Updated row
 */
async function processRequest(orgId, id, { refund_method, gateway_refund_reference: callerGatewayRef }, processedByUserId) {
  // Atomic claim: approved -> processed. Two concurrent process calls can no
  // longer both pass a status check and refund twice; the loser gets a 422.
  const [claim] = await db.query(
    `UPDATE refund_requests SET status = 'processed', processed_at = NOW()
      WHERE id = ? AND organization_id <=> ? AND status = 'approved' AND deleted_at IS NULL`,
    [id, orgId],
  );
  if (!claim || claim.affectedRows !== 1) {
    const current = await RefundRequest.findById(id, orgId);
    if (!current) throw new NotFoundError('Refund request');
    throw new ValidationError(
      `Cannot process a refund request with status '${current.status}'. Must be 'approved'.`,
    );
  }
  const existing = await RefundRequest.findByIdOrFail(id, orgId);

  // Until money moves, a failure releases the claim so the request stays
  // 'approved' and retryable. After a gateway refund succeeds the request must
  // never return to 'approved', or a retry would refund again.
  const state = { moneyMoved: false };
  try {
    return await completeProcessing(orgId, existing, {
      refund_method,
      gateway_refund_reference: callerGatewayRef,
    }, processedByUserId, state);
  } catch (err) {
    if (!state.moneyMoved) {
      await db.query(
        `UPDATE refund_requests SET status = 'approved', processed_at = NULL
          WHERE id = ? AND organization_id <=> ? AND status = 'processed'`,
        [id, orgId],
      ).catch((releaseErr) => logger.error({ err: releaseErr, refundRequestId: id }, 'Could not release refund claim'));
    } else {
      logger.error({ err, refundRequestId: id }, 'Refund sent to the gateway but local bookkeeping failed; request left processed');
    }
    throw err;
  }
}

/**
 * Body of processRequest, run after the request was claimed. Sets
 * state.moneyMoved once a gateway refund has succeeded.
 */
async function completeProcessing(orgId, existing, { refund_method, gateway_refund_reference: callerGatewayRef }, processedByUserId, state) {
  const id = existing.id;
  // Allow the gateway refund path to overwrite the caller-supplied reference
  let gateway_refund_reference = callerGatewayRef || null;

  // Fetch client for notification
  let client = null;
  try {
    const [clientRows] = await db.query(
      'SELECT id, email, name FROM clients WHERE id = ? AND organization_id <=> ? LIMIT 1',
      [existing.client_id, orgId],
    );
    client = clientRows[0] || null;
  } catch (err) {
    logger.warn({ err, clientId: existing.client_id }, 'Could not fetch client for refund processing');
  }

  // --- refund_method: original_method (gateway refund) ---
  // For payments made through a payment gateway (Stripe, Conekta, etc.) the
  // funds must be returned via the same processor before we update our DB.
  if (refund_method === 'original_method') {
    if (!existing.payment_id) {
      throw new ValidationError(
        'Cannot use original_method refund: no payment transaction linked to this refund request.',
      );
    }

    let gatewayResult;
    try {
      gatewayResult = await paymentGatewayService.refund(existing.payment_id, {
        orgId,
        clientId: existing.client_id,
        amount: existing.amount,
      });
      state.moneyMoved = true;
    } catch (err) {
      logger.error({ err, paymentId: existing.payment_id, refundRequestId: id }, 'Gateway refund failed');
      throw err;
    }

    // gateway_refund_reference is returned by paymentGatewayService.refund()
    gateway_refund_reference = gatewayResult.gateway_refund_reference || gateway_refund_reference || null;

    logger.info(
      { refundRequestId: id, paymentId: existing.payment_id, gateway_refund_reference },
      'Gateway refund confirmed',
    );
  }

  // --- refund_method: credit_balance ---
  if (refund_method === 'credit_balance') {
    await db.query(
      `INSERT INTO client_balance_ledger
         (organization_id, client_id, balance_type, entry_type, credit, debit, running_balance,
          reference_id, description, entry_date, created_by)
       VALUES (?, ?, 'postpaid', 'adjustment', ?, 0, 0, ?, ?, CURDATE(), ?)`,
      [
        orgId || null,
        existing.client_id,
        existing.amount,
        existing.id,
        `Refund for request #${existing.id}`,
        processedByUserId || null,
      ],
    );

    // Mark payment as refunded if the refund amount covers the full payment
    if (existing.payment_id) {
      try {
        const [pmtRows] = await db.query(
          `SELECT amount, gateway_status FROM payment_transactions
            WHERE id = ? AND organization_id <=> ? AND client_id = ? LIMIT 1`,
          [existing.payment_id, orgId, existing.client_id],
        );
        const pmt = pmtRows[0];
        if (pmt && parseFloat(existing.amount) >= parseFloat(pmt.amount)) {
          await db.query(
            "UPDATE payment_transactions SET gateway_status = 'refunded' WHERE id = ? AND organization_id <=> ?",
            [existing.payment_id, orgId],
          );
        }
      } catch (err) {
        logger.warn({ err, paymentId: existing.payment_id }, 'Could not mark payment as refunded');
      }
    }
  }

  // --- refund_method: credit_note ---
  // No try/catch: this used to swallow any failure as a warn, which left the
  // request marked 'processed' (the status write is below) with no credit note
  // anywhere — the subscriber is told they were refunded and no document
  // exists. The three refund_method branches are mutually exclusive, so no
  // gateway money has moved on this path; throwing leaves the request
  // 'approved' and retryable, which is the recoverable failure.
  if (refund_method === 'credit_note') {
    const cnNumber = `RCN-${existing.id}-${Date.now()}`;
    const { subtotal, taxAmount, taxRate, currency } = await resolveRefundCreditNoteTax(orgId, existing);
    const [cnResult] = await db.query(
      `INSERT INTO credit_notes
         (organization_id, client_id, invoice_id, credit_note_number, issue_date, reason,
          subtotal, tax_rate, tax_amount, total, currency, status, created_by)
       VALUES (?, ?, ?, ?, CURDATE(), 'other', ?, ?, ?, ?, ?, 'issued', ?)`,
      [
        orgId || null,
        existing.client_id,
        existing.invoice_id || null,
        cnNumber,
        subtotal,
        taxRate,
        taxAmount,
        existing.amount,
        currency,
        processedByUserId || null,
      ],
    );

    // Link the credit note back to the refund request
    await db.query(
      'UPDATE refund_requests SET resulting_credit_note_id = ? WHERE id = ? AND organization_id <=> ?',
      [cnResult.insertId, existing.id, orgId],
    );
  }

  // Always record a billing adjustment
  await billingAdjustmentService.record({
    organizationId: orgId,
    clientId: existing.client_id,
    entityType: existing.payment_id ? 'payment' : 'invoice',
    entityId: existing.payment_id || existing.invoice_id || existing.id,
    adjustmentType: 'correction',
    amountDelta: parseFloat(existing.amount),
    reason: `Refund processed — request #${existing.id} (method: ${refund_method})`,
    approvedBy: processedByUserId || null,
    createdBy: processedByUserId || null,
  });

  // Mark as processed
  const updated = await RefundRequest.update(id, {
    status: 'processed',
    processed_at: new Date(),
    refund_method,
    gateway_refund_reference: gateway_refund_reference || null,
  }, orgId);

  logger.info({ refundRequestId: id, refund_method, orgId }, 'Refund request processed');

  eventBus.emit('refund.processed', {
    organizationId: orgId,
    refundRequest: updated,
    client,
  });

  return updated;
}

module.exports = { createRequest, updateRequest, reviewRequest, processRequest };
