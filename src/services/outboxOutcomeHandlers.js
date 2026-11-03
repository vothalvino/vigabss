// =============================================================================
// Outbox outcome handlers for producers that keep their own record (ASY-33)
// =============================================================================
// messageOutbox loads this module before it reports its first outcome, so
// these run in whichever process delivered the message.
// =============================================================================

const db = require('../config/database');
const messageOutbox = require('./messageOutbox');
const { noteBillingEmail } = require('../utils/opsMetrics');

function withTenant(organizationId, callback) {
  return organizationId === null || organizationId === undefined || typeof db.withTenantContext !== 'function'
    ? callback()
    : db.withTenantContext(Number(organizationId), callback);
}

// A service-modification notice is 'sent' once its message is delivered,
// also when that happens on a later retry (routes/consumerProtection.js).
messageOutbox.onOutcome('service_modification_notice', async (row, outcome) => {
  if (outcome.status !== 'sent') return;
  const note = `Sent by ${row.channel}${outcome.providerMessageId ? ` (${outcome.providerMessageId})` : ''}`;
  await withTenant(row.organization_id, () => db.query(
    `UPDATE service_modification_notices
        SET noticed_at = NOW(), status = 'sent', updated_at = NOW(),
            notes = CONCAT_WS('\n', NULLIF(notes, ''), ?)
      WHERE id = ? AND organization_id = ? AND status = 'pending'`,
    [note, row.source_id, row.organization_id],
  ));
});

// Billing emails (BIL-32) count their real outcome: billing_emails_total
// alerts on undelivered invoices and suspension notices, not on queueing.
const BILLING_KINDS = { invoice_email: 'invoice', suspension_warning: 'suspension_warning', suspension_notice: 'suspension_notice' };
const BILLING_RESULT = { sent: 'sent', skipped: 'skipped', failed: 'failed', outcome_unknown: 'failed', cancelled: 'skipped' };
for (const [sourceType, kind] of Object.entries(BILLING_KINDS)) {
  messageOutbox.onOutcome(sourceType, async (_row, outcome) => {
    noteBillingEmail(kind, BILLING_RESULT[outcome.status] || 'failed');
  });
}

module.exports = {};
