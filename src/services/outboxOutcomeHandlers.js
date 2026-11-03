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

// A campaign message handed to the outbox (campaignService.handOff) gets its
// final state and the campaign its counters. outcome_unknown keeps the
// marker that blocks a redispatch from sending a duplicate.
messageOutbox.onOutcome('campaign_message', async (row, outcome) => {
  const { HANDED_OFF, DELIVERY_OUTCOME_UNKNOWN } = require('./campaignService');
  await withTenant(row.organization_id, async () => {
    const sent = outcome.status === 'sent';
    const [update] = await db.query(
      `UPDATE campaign_messages
          SET status = ?, sent_at = ${sent ? 'NOW()' : 'sent_at'}, provider_message_id = ?, error_message = ?
        WHERE id = ? AND organization_id <=> ? AND status = 'failed' AND error_message = ?`,
      [
        sent ? 'sent' : 'failed',
        outcome.providerMessageId,
        sent ? null : (outcome.status === 'outcome_unknown'
          ? DELIVERY_OUTCOME_UNKNOWN
          : String(outcome.error || outcome.code || outcome.status).slice(0, 1000)),
        row.source_id, row.organization_id, HANDED_OFF,
      ],
    );
    if (update.affectedRows !== 1) return;
    await db.query(
      `UPDATE communication_campaigns cc
         JOIN campaign_messages cm ON cm.campaign_id = cc.id AND cm.organization_id <=> cc.organization_id
          SET cc.${sent ? 'sent_count = cc.sent_count' : 'failed_count = cc.failed_count'} + 1
        WHERE cm.id = ? AND cm.organization_id <=> ?`,
      [row.source_id, row.organization_id],
    );
  });
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
