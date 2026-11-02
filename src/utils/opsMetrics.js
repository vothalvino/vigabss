'use strict';

// =============================================================================
// Operational metrics recorded outside HTTP (OPS-15)
// =============================================================================
// The shipped backup alert queried fireisp_last_backup_timestamp_seconds and
// nothing exported it; scheduled tasks had no run or failure counters. These
// are recorded where the work happens and read by /metrics.
// =============================================================================

const { registry } = require('./metricsRegistry');

const scheduledTaskRuns = registry.counter({
  name: 'scheduled_task_runs_total',
  help: 'Scheduled task runs by task and outcome',
  labelNames: ['task', 'status'],
  maxSeries: 400,
});

// ASY-38: a failed audit write was only logged, so a broken audit trail went
// unnoticed (it once stayed empty for months). Counted here so /metrics
// always exports it and VigaBSS_AuditLogWriteFailures can alert.
const auditWriteFailures = registry.counter({
  name: 'audit_log_write_failures_total',
  help: 'Audit log rows that could not be written',
});

let lastBackupSeconds = null;
let lastBackupLoadedAt = 0;
const BACKUP_RELOAD_MS = 5 * 60 * 1000;

function noteBackupSuccess(at = new Date()) {
  lastBackupSeconds = Math.floor(at.getTime() / 1000);
  lastBackupLoadedAt = Date.now();
}

// After a restart the timestamp is read back from backup_runs (the backup may
// have run in another process). The refresh is asynchronous; a scrape never
// waits on the database.
function refreshLastBackupFromDb() {
  if (Date.now() - lastBackupLoadedAt < BACKUP_RELOAD_MS) return;
  lastBackupLoadedAt = Date.now();
  const db = require('../config/database');
  db.query("SELECT UNIX_TIMESTAMP(MAX(finished_at)) AS ts FROM backup_runs WHERE status = 'success'")
    .then(([[row]]) => {
      const ts = Number(row?.ts);
      if (Number.isFinite(ts) && ts > 0 && (lastBackupSeconds === null || ts > lastBackupSeconds)) lastBackupSeconds = ts;
    })
    .catch(() => {});
}

registry.collected({
  name: 'fireisp_last_backup_timestamp_seconds',
  help: 'Unix time of the last successful database backup',
  collect: () => {
    refreshLastBackupFromDb();
    return lastBackupSeconds;
  },
});

function noteTaskRun(task, status) {
  scheduledTaskRuns.inc({ task, status });
}

function noteAuditWriteFailure() {
  auditWriteFailures.inc();
}

// Billing, payment and PAC outcomes (BIL-32). Failures were only logged, or
// not even that, so a broken gateway or PAC showed up as missing money days
// later instead of as an alert.
const billingInvoices = registry.counter({
  name: 'billing_invoices_total',
  help: 'Scheduled invoice generation per contract (result: generated, failed)',
  labelNames: ['result'],
});
const billingEmails = registry.counter({
  name: 'billing_emails_total',
  help: 'Billing emails to clients (kind: invoice, suspension_warning, suspension_notice; result: sent, failed)',
  labelNames: ['kind', 'result'],
});
const autopayCharges = registry.counter({
  name: 'billing_autopay_charges_total',
  help: 'Recurring charges of stored payment methods (result: charged, skipped, failed)',
  labelNames: ['result'],
});
const paymentRetries = registry.counter({
  name: 'billing_payment_retries_total',
  help: 'Scheduled payment retries (result: succeeded, failed, exhausted, cancelled)',
  labelNames: ['result'],
});
const paymentWebhooks = registry.counter({
  name: 'payment_webhook_events_total',
  help: 'Payment gateway webhook events (status: processed, ignored, duplicate, no_match, failed)',
  labelNames: ['provider', 'status'],
  maxSeries: 50,
});
const reconcileFailures = registry.counter({
  name: 'payment_reconcile_failures_total',
  help: 'Succeeded gateway transactions that could not be posted as a payment',
});
const pacErrors = registry.counter({
  name: 'cfdi_pac_errors_total',
  help: 'Failed PAC calls (operation: stamp, cancel, cancel_status)',
  labelNames: ['provider', 'operation'],
  maxSeries: 50,
});

const noteInvoiceRun = result => billingInvoices.inc({ result });
const noteBillingEmail = (kind, result) => billingEmails.inc({ kind, result });
const noteAutopayCharge = result => autopayCharges.inc({ result });
const notePaymentRetry = result => paymentRetries.inc({ result });
const notePaymentWebhook = (provider, status) => paymentWebhooks.inc({ provider, status });
const noteReconcileFailure = () => reconcileFailures.inc();
const notePacError = (provider, operation) => pacErrors.inc({ provider, operation });

module.exports = {
  noteBackupSuccess, noteTaskRun, noteAuditWriteFailure, scheduledTaskRuns, auditWriteFailures,
  noteInvoiceRun, noteBillingEmail, noteAutopayCharge, notePaymentRetry, notePaymentWebhook,
  noteReconcileFailure, notePacError,
};
