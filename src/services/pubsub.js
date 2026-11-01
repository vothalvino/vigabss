// =============================================================================
// VigaBSS 5.0 — Shared pub/sub instance (P3.9)
// =============================================================================

const { createPubSub } = require('graphql-yoga');

const pubsub = createPubSub();

/**
 * A comment was added to a ticket. Every writer calls this — staff, portal
 * and AI replies; only staff comments did, so live updates missed the
 * customer's and the AI's (GQL-05). The organization is part of the event:
 * ticket ids are per database, and isolated tenants have their own.
 */
function publishTicketComment(organizationId, ticketId, comment) {
  pubsub.publish('TICKET_COMMENT_ADDED', {
    ticketCommentAdded: comment,
    ticketId: String(ticketId),
    orgId: organizationId ?? null,
  });
}

module.exports = { pubsub, publishTicketComment };
