// =============================================================================
// VigaBSS 5.0 — Communication Delivery Webhook Route — §1.4
// =============================================================================
// Receives provider delivery status callbacks (email and SMS providers).
// No authentication — uses a shared secret header for basic verification.
// Mounted at /communication in app.js.
// =============================================================================

const crypto = require('crypto');
const { Router } = require('express');
const campaignService = require('../services/campaignService');
const deliveryFeedback = require('../services/deliveryFeedbackService');
const logger = require('../utils/logger');
const { verifyTwilioSignature } = require('../services/whatsappWebhookService');

// Who may report a delivery outcome (TNA-23). A Twilio StatusCallback proves
// itself with X-Twilio-Signature (TWILIO_AUTH_TOKEN); any other caller sends
// WEBHOOK_DELIVERY_SECRET, compared in constant time. With neither configured
// the endpoint is closed outside development and test, instead of open to any
// unauthenticated POST.
function authenticateDeliveryCallback(req) {
  if (req.headers['x-twilio-signature'] && process.env.TWILIO_AUTH_TOKEN) {
    return verifyTwilioSignature(req, process.env.TWILIO_AUTH_TOKEN) ? 'ok' : 'denied';
  }
  const secret = process.env.WEBHOOK_DELIVERY_SECRET;
  if (!secret) {
    return ['development', 'test'].includes(process.env.NODE_ENV) ? 'ok' : 'unconfigured';
  }
  const provided = req.headers['x-webhook-secret'] || req.headers['x-delivery-secret'];
  if (typeof provided !== 'string') return 'denied';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'ok' : 'denied';
}

const router = Router();

// Map Twilio MessageStatus values to our internal statuses
const TWILIO_STATUS_MAP = {
  delivered:   'delivered',
  undelivered: 'failed',
  failed:      'failed',
  read:        'opened',
};

// Twilio error codes that are about the recipient, not the attempt (ASY-33):
// a STOP reply, or a number that can never receive SMS.
const TWILIO_UNSUBSCRIBED = new Set(['21610']);
const TWILIO_UNDELIVERABLE = new Set(['21211', '21614', '30005', '30006']);

// What a report means for the recipient: bounce, complaint, unsubscribe or
// nothing. A generic 'bounced' is a hard bounce unless permanent is false.
function feedbackEvent(body) {
  if (body.MessageSid) {
    const code = String(body.ErrorCode || '');
    if (TWILIO_UNSUBSCRIBED.has(code)) return 'unsubscribe';
    if (TWILIO_UNDELIVERABLE.has(code)) return 'bounce';
    return null;
  }
  if (body.status === 'bounced' && body.permanent !== false) return 'bounce';
  if (body.status === 'complained') return 'complaint';
  if (body.status === 'unsubscribed') return 'unsubscribe';
  return null;
}

/**
 * @openapi
 * /communication/delivery-webhook:
 *   post:
 *     summary: Receive a provider delivery status callback
 *     tags: [Communication]
 *     description: >
 *       Public webhook endpoint for provider delivery callbacks. Secured via the
 *       WEBHOOK_DELIVERY_SECRET environment variable (sent as X-Webhook-Secret header).
 *       Supports both generic JSON payloads and Twilio StatusCallback POST bodies.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               provider_message_id:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [delivered, bounced, opened, failed, complained, unsubscribed]
 *                 description: >
 *                   bounced (a hard bounce unless permanent is false) stops sends to
 *                   that address until it changes; complained withdraws marketing
 *                   consent; unsubscribed opts the client out of that channel.
 *               permanent:
 *                 type: boolean
 *               timestamp:
 *                 type: string
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             properties:
 *               MessageSid:
 *                 type: string
 *               MessageStatus:
 *                 type: string
 *               ErrorCode:
 *                 type: string
 *                 description: 21610 (STOP) unsubscribes; 21211, 21614, 30005, 30006 mark the number undeliverable
 *     responses:
 *       200:
 *         description: Callback processed
 *       401:
 *         description: Invalid webhook secret
 */
router.post('/delivery-webhook', async (req, res) => {
  const auth = authenticateDeliveryCallback(req);
  if (auth === 'unconfigured') {
    logger.warn('Delivery webhook refused: set WEBHOOK_DELIVERY_SECRET (or TWILIO_AUTH_TOKEN for Twilio callbacks)');
    return res.status(503).json({ error: 'Delivery webhook is not configured' });
  }
  if (auth !== 'ok') {
    logger.warn({ ip: req.ip }, 'Delivery webhook: invalid secret or signature');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = req.body || {};

    let providerMessageId;
    let newStatus;

    // Detect Twilio StatusCallback format (form-urlencoded via Express body parser)
    if (body.MessageSid && body.MessageStatus) {
      providerMessageId = body.MessageSid;
      newStatus = TWILIO_STATUS_MAP[body.MessageStatus] || null;
    } else {
      // Generic JSON format
      providerMessageId = body.provider_message_id;
      newStatus = body.status;
    }

    const event = feedbackEvent(body);
    if (!providerMessageId || (!newStatus && !event)) {
      return res.status(200).json({ updated: false, reason: 'missing fields' });
    }

    // A campaign message's own delivery state, then what the report means
    // for the recipient (suppress a dead address, honour STOP or a spam
    // complaint) for any message the outbox sent.
    const campaignStatus = ['delivered', 'bounced', 'opened', 'failed'].includes(newStatus) ? newStatus : null;
    const result = campaignStatus
      ? await campaignService.handleDeliveryCallback(providerMessageId, campaignStatus, body)
      : { updated: false };
    const feedback = event
      ? await deliveryFeedback.recordProviderEvent({ providerMessageId, event })
      : { applied: false };
    res.status(200).json({ ...result, feedback });
  } catch (err) {
    logger.error({ err }, 'Delivery webhook processing error');
    // Return 200 to avoid provider retry storms; never echo internals.
    res.status(200).json({ updated: false, error: 'processing_failed' });
  }
});

module.exports = router;
