// =============================================================================
// Provider delivery feedback: bounces, complaints and unsubscribes (ASY-33)
// =============================================================================
// A provider reports, for a message it accepted, that the address is dead
// (hard bounce), that the recipient marked it as spam (complaint), or that
// they replied STOP (unsubscribe). Keeping sending after those hurts the
// sender's reputation until the provider throttles or blocks it.
//
//   bounce       the address is undeliverable: client_contact_suppressions
//                refuses it for every class until the address changes (the
//                suppression is tied to the contact epoch it was sent to)
//   complaint    marketing consent for that channel is withdrawn
//   unsubscribe  a do-not-contact opt-out for that channel
//
// The message is found by the provider's id in message_outbox, on the
// primary database or an isolated tenant's.
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'deliveryFeedback' });
const communicationPreferences = require('./clientCommunicationPreferenceService');
const { isolatedOrganizationIds } = require('./organizationFanOut');
const { noteOutboxMessage } = require('../utils/opsMetrics');

const EVENTS = Object.freeze(['bounce', 'complaint', 'unsubscribe']);

function inScope(orgId, callback) {
  if (orgId === null) {
    return typeof db.withPrimaryContext === 'function' ? db.withPrimaryContext(callback) : callback();
  }
  return db.withTenantContext(orgId, callback);
}

async function findMessage(providerMessageId) {
  const lookup = () => db.query(
    `SELECT id, organization_id, client_id, channel, recipient, client_contact_epoch
       FROM message_outbox WHERE provider_message_id = ? AND status = 'sent' ORDER BY id DESC LIMIT 1`,
    [providerMessageId],
  );
  const [primary] = await inScope(null, lookup);
  const isolated = await isolatedOrganizationIds();
  const onPrimary = primary.find(r => !isolated.includes(Number(r.organization_id)));
  if (onPrimary) return { row: onPrimary, scopeOrgId: null };
  for (const orgId of isolated) {
    const [rows] = await inScope(orgId, lookup);
    const row = rows.find(r => Number(r.organization_id) === orgId);
    if (row) return { row, scopeOrgId: orgId };
  }
  return null;
}

/**
 * Apply one provider report to the client it concerns.
 * @param {{ providerMessageId: string, event: 'bounce'|'complaint'|'unsubscribe' }} report
 * @returns {Promise<{ applied: boolean, reason?: string }>}
 */
async function recordProviderEvent({ providerMessageId, event }) {
  if (!providerMessageId || !EVENTS.includes(event)) return { applied: false, reason: 'unsupported' };
  const found = await findMessage(providerMessageId);
  if (!found) return { applied: false, reason: 'message_not_found' };
  const { row, scopeOrgId } = found;
  if (!row.client_id || !['email', 'sms', 'whatsapp'].includes(row.channel)) {
    return { applied: false, reason: 'not_a_client_message' };
  }

  return inScope(scopeOrgId, async () => {
    const [[client]] = await db.query(
      `SELECT email_contact_epoch, phone_contact_epoch FROM clients
        WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
      [row.client_id, row.organization_id],
    );
    if (!client) return { applied: false, reason: 'client_not_found' };
    const epoch = Number(row.channel === 'email' ? client.email_contact_epoch : client.phone_contact_epoch);
    // The client has a new address since this message: the report is about
    // one they no longer use.
    if (epoch !== Number(row.client_contact_epoch || 0)) return { applied: false, reason: 'address_changed' };

    await db.query(
      `INSERT IGNORE INTO client_contact_suppressions
         (organization_id, client_id, channel, contact_epoch, destination, reason, provider_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.organization_id, row.client_id, row.channel, epoch, row.recipient, event, providerMessageId],
    );
    if (event === 'complaint') {
      await db.query(
        `UPDATE subscriber_consents SET withdrawn_at = COALESCE(withdrawn_at, NOW())
          WHERE client_id = ? AND organization_id <=> ? AND purpose = 'marketing'
            AND communication_channel = ? AND withdrawn_at IS NULL`,
        [row.client_id, row.organization_id, row.channel],
      );
    } else if (event === 'unsubscribe') {
      await communicationPreferences.writePreferenceWithRun((sql, params) => db.query(sql, params), {
        organizationId: row.organization_id,
        clientId: row.client_id,
        channel: row.channel,
        optOut: true,
        reason: 'The recipient unsubscribed at the provider (STOP)',
      });
    }
    noteOutboxMessage(row.channel, event);
    logger.info({ outboxId: row.id, clientId: row.client_id, channel: row.channel, event }, 'Provider delivery feedback applied');
    return { applied: true };
  });
}

module.exports = { recordProviderEvent, EVENTS };
