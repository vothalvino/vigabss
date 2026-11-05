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

// ASY-28: how long each run took, so a task creeping toward its interval
// shows before it starts overlapping.
const scheduledTaskDuration = registry.histogram({
  name: 'scheduled_task_duration_seconds',
  help: 'Scheduled task run duration by task',
  labelNames: ['task'],
  buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600],
  maxSeries: 200,
});

function noteTaskRun(task, status, durationMs = null) {
  scheduledTaskRuns.inc({ task, status });
  if (durationMs !== null) scheduledTaskDuration.observe({ task }, durationMs / 1000);
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
  help: 'Billing emails to clients by final outcome (kind: invoice, suspension_warning, suspension_notice; result: sent, skipped, failed)',
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

// Message outbox (ASY-33): delivery results per attempt, and the backlog the
// last delivery run saw, so a stuck queue or failing provider alerts.
const outboxMessages = registry.counter({
  name: 'outbox_messages_total',
  help: 'Outbox delivery attempts by channel and result (sent, skipped, retried, failed, outcome_unknown, deferred)',
  labelNames: ['channel', 'result'],
});
let outboxBacklog = { rows: [], oldestQueuedSeconds: 0 };
registry.collected({
  name: 'outbox_backlog_messages',
  help: 'Outbox messages waiting or needing attention, by status and channel (refreshed by each delivery run)',
  collect: () => outboxBacklog.rows.map(r => ({ labels: { status: r.status, channel: r.channel }, value: r.n })),
});
registry.collected({
  name: 'outbox_oldest_queued_seconds',
  help: 'Age of the oldest message still waiting to be delivered',
  collect: () => outboxBacklog.oldestQueuedSeconds,
});
const noteOutboxMessage = (channel, result) => outboxMessages.inc({ channel, result });
const noteOutboxBacklog = (rows, oldestQueuedSeconds) => { outboxBacklog = { rows, oldestQueuedSeconds }; };

// Jobs per queue and state (waiting, active, delayed, failed), read from the
// queue when /metrics is scraped. A queue whose waiting count only grows has
// workers that cannot keep up or have stopped.
const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'];
let queueDepth = [];
registry.collected({
  name: 'job_queue_jobs',
  help: 'Background jobs per queue and state, as of the last scrape',
  collect: () => queueDepth,
});
function noteQueueDepth(queues) {
  queueDepth = (queues || []).flatMap(q => QUEUE_STATES
    .filter(state => typeof q[state] === 'number')
    .map(state => ({ labels: { queue: q.name, state }, value: q[state] })));
}

// RADIUS accounting requests by Acct-Status-Type and how they were answered:
// accepted (2xx), rejected (4xx), unauthorized (bad shared secret) or error
// (5xx). A NAS whose accounting is rejected bills and attributes nothing.
const radiusAccounting = registry.counter({
  name: 'radius_accounting_requests_total',
  help: 'RADIUS accounting requests by Acct-Status-Type and result',
  labelNames: ['status_type', 'result'],
});
const ACCOUNTING_STATUS_TYPES = new Set(['Start', 'Stop', 'Interim-Update', 'Accounting-On', 'Accounting-Off']);
function noteRadiusAccounting(statusType, httpStatus) {
  const result = httpStatus === 401 ? 'unauthorized'
    : httpStatus >= 500 ? 'error'
      : httpStatus >= 400 ? 'rejected'
        : 'accepted';
  radiusAccounting.inc({ status_type: ACCOUNTING_STATUS_TYPES.has(statusType) ? statusType : 'other', result });
}

// SNMP traps dropped because their community or SNMPv3 user did not
// authenticate them as the device they came from (NET-24).
const snmpTrapAuthDrops = registry.counter({
  name: 'snmp_trap_dropped_auth_total',
  help: 'SNMP traps dropped for failed authentication (reason: unknown_community, unknown_user, security_level, bad_digest, decrypt_failed, community_mismatch, user_mismatch, no_credentials)',
  labelNames: ['reason'],
  maxSeries: 20,
});
const noteSnmpTrapAuthDrop = reason => snmpTrapAuthDrops.inc({ reason });

module.exports = {
  noteSnmpTrapAuthDrop,
  noteOutboxMessage, noteOutboxBacklog, noteQueueDepth, noteRadiusAccounting,
  noteBackupSuccess, noteTaskRun, noteAuditWriteFailure, scheduledTaskRuns, auditWriteFailures,
  noteInvoiceRun, noteBillingEmail, noteAutopayCharge, notePaymentRetry, notePaymentWebhook,
  noteReconcileFailure, notePacError,
};
