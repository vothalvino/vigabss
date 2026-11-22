// =============================================================================
// VigaBSS 5.0 — Portal chat answered by the support conversation engine
// =============================================================================
// The portal chat used to hand every message to the ticket-reply pipeline
// (aiReplyService): it opened a ticket on the first message and wrote a
// letter-style reply from the ticket alone, so a customer who typed "my
// internet is slow" was asked for their account number and five other things
// the system already knows.
//
// When the organization lets the assistant answer on the portal by itself
// (AI on, portal channel on, mode auto_send, a provider selected), the chat is
// answered by supportConversationService instead: the same engine as the
// WhatsApp bot and the Conversations tab. It reads the customer's account and
// connection, answers in a few sentences, and opens a ticket (with the
// transcript) only when it hands the chat to staff.
//
// In every other configuration the route keeps its earlier behaviour: a
// ticket per session, and AI text shown to the customer only when it was
// really sent. A draft kept for staff review is never shown.
// =============================================================================

const AiPolicy = require('../models/AiPolicy');
const supportAiWriter = require('./supportAiWriter');
const logger = require('../utils/logger').child({ service: 'portalChatEngine' });

// support_conversations.channel for chats started in the customer portal.
// The staff Conversations tab starts its own as 'web'; both are 'portal' to
// the AI policy.
const CHANNEL = 'portal';

/** May the support engine answer this organization's portal chat by itself? */
async function enabledFor(orgId) {
  try {
    if (!orgId) return false;
    const policy = await AiPolicy.findByOrgId(orgId);
    return supportAiWriter.enabledFor(policy, CHANNEL)
      && policy.mode === 'auto_send'
      && Boolean(policy.active_provider_id);
  } catch (err) {
    logger.warn({ err: err.message, orgId }, 'portalChatEngine: could not read the AI policy');
    return false;
  }
}

/**
 * Answer one portal chat message. Starts the support conversation on the
 * first message and continues it afterwards.
 *
 * @returns {Promise<{conversationId: number, text: string|null, escalated: boolean, ticketId: number|null}|null>}
 *          null when the engine produced nothing usable (the caller hands the
 *          chat to staff the earlier way). Never throws.
 */
async function answer({ orgId, clientId, conversationId = null, message }) {
  try {
    const support = require('./supportConversationService');
    const result = conversationId
      ? await support.sendMessage({ conversationId, orgId, content: message, clientId })
      : await support.startConversation({ orgId, clientId, channel: CHANNEL, message });
    const conversation = result?.conversation;
    if (!conversation?.id) return null;

    const lastAssistant = [...(result.messages || [])].reverse().find(m => m.role === 'assistant');
    const escalated = conversation.status === 'escalated';
    const text = lastAssistant?.content ? String(lastAssistant.content) : null;
    if (!text && !escalated) return null;
    return { conversationId: conversation.id, text, escalated, ticketId: conversation.ticket_id || null };
  } catch (err) {
    logger.warn({ err: err.message, orgId, conversationId }, 'portalChatEngine: the support engine failed; handing the chat to staff');
    return null;
  }
}

module.exports = { enabledFor, answer, CHANNEL };
