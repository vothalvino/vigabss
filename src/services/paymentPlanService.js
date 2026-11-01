// =============================================================================
// VigaBSS 5.0 — Payment Plan Service
// =============================================================================

const db = require('../config/database');
const repService = require('./repService');
const logger = require('../utils/logger').child({ service: 'paymentPlan' });
const { NotFoundError, ValidationError } = require('../utils/errors');
const { creditAppliedSql } = require('../utils/invoiceBalance');

/**
 * Compute installment due dates starting from the day after creation.
 * @param {number} count
 * @param {'weekly'|'biweekly'|'monthly'} frequency
 * @returns {string[]} ISO date strings (YYYY-MM-DD)
 */
function computeDueDates(count, frequency) {
  // First due date = midnight tomorrow
  const base = new Date(Date.now());
  base.setDate(base.getDate() + 1);
  base.setHours(0, 0, 0, 0);

  const dates = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    if (frequency === 'weekly') {
      d.setDate(base.getDate() + i * 7);
    } else if (frequency === 'biweekly') {
      d.setDate(base.getDate() + i * 14);
    } else {
      // monthly
      d.setMonth(base.getMonth() + i);
    }
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Split a total amount into N installment amounts.
 * Each installment = floor(total / n * 100) / 100.
 * The last installment absorbs the rounding remainder.
 * @param {number} total
 * @param {number} count
 * @returns {number[]}
 */
function splitAmounts(total, count) {
  const unit = Math.floor((total / count) * 100) / 100;
  const amounts = Array(count).fill(unit);
  // Last installment gets the remainder to ensure exact sum
  const sumOfOthers = unit * (count - 1);
  amounts[count - 1] = Math.round((total - sumOfOthers) * 100) / 100;
  return amounts;
}

/**
 * Create a payment plan from an unpaid invoice.
 * Splits the invoice total into N installments based on frequency.
 */
async function createPlan({
  organizationId,
  clientId,
  invoiceId,
  totalAmount,
  installmentCount,
  frequency,
  notes,
  createdBy,
}) {
  // A plan for an invoice splits what the invoice still owes.
  let resolvedTotal = totalAmount;
  if (invoiceId) {
    const [invRows] = await db.query(
      `SELECT i.*,
              (i.total - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                                    WHERE pa.invoice_id = i.id AND pa.deleted_at IS NULL), 0)
                       - ${creditAppliedSql('i')}) AS balance_due
         FROM invoices i WHERE i.id = ? AND i.organization_id = ? AND i.deleted_at IS NULL`,
      [invoiceId, organizationId],
    );
    const invoice = invRows[0];
    if (!invoice) throw new NotFoundError('invoices');
    // The plan is the client's: an invoice of another client cannot be split
    // into it (TNB-28).
    if (Number(invoice.client_id) !== Number(clientId)) {
      throw new ValidationError('invoice_id does not belong to client_id', [{ field: 'invoice_id', message: 'the invoice must belong to the plan\'s client' }]);
    }
    if (!['issued', 'sent', 'overdue'].includes(invoice.status)) {
      throw new ValidationError(`Only an unpaid invoice can be split into a payment plan (this one is ${invoice.status}).`);
    }
    resolvedTotal = Math.round(parseFloat(invoice.balance_due ?? invoice.total) * 100) / 100;
  }

  if (!resolvedTotal || resolvedTotal <= 0) {
    throw new ValidationError('total_amount must be greater than zero');
  }

  if (installmentCount < 1 || installmentCount > 60) {
    throw new ValidationError('installment_count must be between 1 and 60');
  }

  const dueDates = computeDueDates(installmentCount, frequency);
  const amounts = splitAmounts(resolvedTotal, installmentCount);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [planResult] = await conn.execute(
      `INSERT INTO payment_plans
         (organization_id, client_id, total_amount, installment_count, frequency, status, notes, created_by)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      [organizationId, clientId, resolvedTotal, installmentCount, frequency, notes || null, createdBy],
    );
    const planId = planResult.insertId;

    const installments = [];
    for (let i = 0; i < installmentCount; i++) {
      // invoice_id on every installment: paying one allocates to the invoice,
      // and suspension and late fees skip it while the plan is active (BIL-17).
      const [instResult] = await conn.execute(
        `INSERT INTO payment_plan_installments
           (organization_id, plan_id, invoice_id, sequence, amount, due_date, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [organizationId, planId, invoiceId || null, i + 1, amounts[i], dueDates[i]],
      );
      installments.push({
        id: instResult.insertId,
        plan_id: planId,
        invoice_id: invoiceId || null,
        sequence: i + 1,
        amount: amounts[i],
        due_date: dueDates[i],
        status: 'pending',
      });
    }

    await conn.commit();

    const [planRows] = await db.query('SELECT * FROM payment_plans WHERE id = ?', [planId]);
    return { plan: planRows[0], installments };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Record payment for an installment (BIL-17).
 *
 * In one transaction, with the plan, the installment and the payment locked:
 * the payment must be the plan client's own completed payment, not already
 * used for another installment, with enough left unallocated to cover the
 * installment. When the installment covers an invoice, the payment is
 * allocated to it and the invoice turns paid once covered. After commit:
 * reconnect, cancel pending charge retries and generate the REP.
 */
async function payInstallment(planId, sequence, paymentId, orgId) {
  const paymentAllocationService = require('./paymentAllocationService');
  const conn = await db.getConnection();
  const exec = conn.execute.bind(conn);
  let settled;
  try {
    await conn.beginTransaction();

    const [planRows] = await exec(
      'SELECT * FROM payment_plans WHERE id = ? AND organization_id = ? AND deleted_at IS NULL FOR UPDATE',
      [planId, orgId],
    );
    const plan = planRows[0];
    if (!plan) throw new NotFoundError('payment_plans');
    if (plan.status !== 'active') throw new ValidationError(`This payment plan is ${plan.status}.`);

    const [instRows] = await exec(
      'SELECT * FROM payment_plan_installments WHERE plan_id = ? AND sequence = ? FOR UPDATE',
      [planId, sequence],
    );
    const installment = instRows[0];
    if (!installment) throw new NotFoundError('payment_plan_installments');
    if (installment.status === 'paid') throw new ValidationError('Installment is already paid');

    const [payRows] = await exec(
      'SELECT * FROM payments WHERE id = ? AND organization_id = ? AND deleted_at IS NULL FOR UPDATE',
      [paymentId, orgId],
    );
    const payment = payRows[0];
    if (!payment) throw new NotFoundError('payments');
    if (payment.status !== 'completed') {
      throw new ValidationError(`Only a completed payment can settle an installment (this payment is ${payment.status}).`);
    }
    if (Number(payment.client_id) !== Number(plan.client_id)) {
      throw new ValidationError('The payment belongs to a different client than the payment plan.');
    }
    // The invoice too, before any read that sums allocations (DAL-04).
    await paymentAllocationService.lockInvoicesForAllocation(exec, orgId, { invoiceIds: [installment.invoice_id] });
    const [usedRows] = await exec(
      'SELECT id FROM payment_plan_installments WHERE paid_payment_id = ? LIMIT 1',
      [paymentId],
    );
    if (usedRows[0]) throw new ValidationError('This payment already settled another installment.');

    const [allocRows] = await exec(
      'SELECT COALESCE(SUM(amount), 0) AS allocated FROM payment_allocations WHERE payment_id = ? AND deleted_at IS NULL',
      [paymentId],
    );
    const unallocated = Math.round((Number(payment.amount) - Number(allocRows[0]?.allocated || 0)) * 100) / 100;
    const due = Number(installment.amount);
    if (unallocated + 0.005 < due) {
      throw new ValidationError(
        `The payment has ${unallocated.toFixed(2)} left unallocated; the installment is ${due.toFixed(2)}.`,
      );
    }

    let invoice = null;
    let allocated = 0;
    if (installment.invoice_id) {
      const invoices = await paymentAllocationService.getInvoicesWithBalance(
        exec, orgId, plan.client_id, [installment.invoice_id], true,
      );
      invoice = invoices[0] || null;
      // Never more than the invoice still owes (it may have been paid down
      // outside the plan); the rest of the installment stays client credit.
      allocated = invoice ? Math.min(due, Math.round(Number(invoice.balance_due) * 100) / 100) : 0;
      if (allocated > 0.005) {
        await exec(
          'INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)',
          [paymentId, invoice.id, allocated],
        );
      }
    }
    const becamePaid = invoice && allocated > 0.005
      ? await paymentAllocationService.finalizeIfFullyPaid(exec, invoice)
      : false;

    await exec(
      `UPDATE payment_plan_installments
         SET status = 'paid', paid_payment_id = ?, paid_at = NOW()
       WHERE id = ?`,
      [paymentId, installment.id],
    );
    const [remainRows] = await exec(
      "SELECT COUNT(*) AS remaining FROM payment_plan_installments WHERE plan_id = ? AND status != 'paid'",
      [planId],
    );
    if (Number(remainRows[0].remaining) === 0) {
      await exec("UPDATE payment_plans SET status = 'completed' WHERE id = ?", [planId]);
    }

    await conn.commit();
    settled = { invoice, allocated, becamePaid, installmentId: installment.id };
  } catch (err) {
    try { await conn.rollback(); } catch (_rollbackErr) { /* keep the original error */ }
    throw err;
  } finally {
    conn.release();
  }

  // Post-commit, best-effort: the money is already posted.
  const { invoice, allocated, becamePaid } = settled;
  if (invoice && becamePaid) {
    try {
      await paymentAllocationService.reconnectIfSuspended(invoice, null, orgId);
      await require('./paymentRetryService').cancelRetries({ invoiceId: invoice.id });
    } catch (err) {
      logger.error({ err, planId, invoiceId: invoice.id }, 'Post-payment follow-up for an installment failed');
    }
  }
  if (invoice && allocated > 0.005) {
    await repService.maybeGenerateRep(paymentId, invoice.id, allocated, orgId, null);
  }

  const [updatedInst] = await db.query('SELECT * FROM payment_plan_installments WHERE id = ?', [settled.installmentId]);
  return updatedInst[0];
}

/**
 * Check for overdue installments across all orgs.
 * Marks any pending installments with past due_date as overdue.
 * Emits a notification event if the notification_events table exists.
 */
async function checkInstallmentsDue() {
  logger.info('Checking for overdue installments');

  try {
    // Mark overdue installments
    const [result] = await db.query(
      `UPDATE payment_plan_installments
         SET status = 'overdue'
       WHERE status = 'pending' AND due_date < CURDATE()`,
    );

    const affectedCount = result.affectedRows;
    logger.info({ affectedCount }, 'Marked installments as overdue');

    if (affectedCount === 0) return;

    // Fetch newly overdue installments to emit notifications
    const [overdueRows] = await db.query(
      `SELECT ppi.*, pp.organization_id, pp.client_id
       FROM payment_plan_installments ppi
       JOIN payment_plans pp ON pp.id = ppi.plan_id
       WHERE ppi.status = 'overdue' AND ppi.due_date < CURDATE()
       LIMIT 500`,
    );

    // There is no `notification_events` table in the schema and never has been
    // (database/schema.sql), so the INSERT that used to be here threw for every
    // row and the catch below swallowed it — the log line was the only thing that
    // ever ran. Log honestly instead of pretending to enqueue an event.
    // TODO: emit a real notification once overdue installments have a channel.
    for (const inst of overdueRows) {
      logger.info(
        {
          organization_id: inst.organization_id,
          client_id: inst.client_id,
          plan_id: inst.plan_id,
          installment_id: inst.id,
          sequence: inst.sequence,
          amount: inst.amount,
          due_date: inst.due_date,
        },
        'Overdue installment detected (no notification channel wired yet)',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Error checking installments due');
    throw err;
  }
}

/**
 * Get a plan with its installments.
 */
async function getPlanWithInstallments(planId, orgId) {
  const [planRows] = await db.query(
    'SELECT * FROM payment_plans WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [planId, orgId],
  );
  const plan = planRows[0];
  if (!plan) throw new NotFoundError('payment_plans');

  const [installments] = await db.query(
    'SELECT * FROM payment_plan_installments WHERE plan_id = ? ORDER BY sequence ASC',
    [planId],
  );

  return { plan, installments };
}

module.exports = { createPlan, payInstallment, checkInstallmentsDue, getPlanWithInstallments };
