// =============================================================================
// Outbox outcome handlers for producers that keep their own record (ASY-33)
// =============================================================================
// messageOutbox loads this module before it reports its first outcome, so
// these run in whichever process delivered the message.
// =============================================================================

const db = require('../config/database');
const messageOutbox = require('./messageOutbox');

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

module.exports = {};
