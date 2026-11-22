// =============================================================================
// VigaBSS 5.0 — WhatsApp outbound (bot replies)
// =============================================================================
// Sends a bot reply back to a WhatsApp number through whichever provider is
// active. Self-contained (not smsTransport) for two reasons: replies must work
// for UNBOUND senders where we have no organization_id yet (sms_logs.org is NOT
// NULL), and Meta Cloud API outbound is a different transport smsTransport does
// not implement. When an org IS known (a bound client), the send is also logged
// to sms_logs for history, best-effort.
//
// Replies are only ever sent in response to an inbound message, so they fall
// inside the provider's customer-service window — free-form text, no template.
// =============================================================================

const https = require('https');
const { URLSearchParams } = require('url');
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger');
const communicationPreferences = require('./clientCommunicationPreferenceService');

// Lazy: the settings service reads the database at load in some test setups.
const whatsappSettings = () => require('./whatsappSettingsService');

/** POST helper returning { sid, status } or throwing. */
function httpsPost({ hostname, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch (_e) { /* non-JSON */ }
        if (res.statusCode >= 400) {
          const msg = parsed.error?.message || parsed.message || `HTTP ${res.statusCode}`;
          const err = new Error(msg);
          err.code = String(parsed.error?.code || res.statusCode);
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('WhatsApp send timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendViaTwilio({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_FROM || ''}`;
  const post = new URLSearchParams({ To: `whatsapp:${to}`, From: from, Body: body }).toString();
  return httpsPost({
    hostname: 'api.twilio.com',
    path: `/2010-04-01/Accounts/${sid}/Messages.json`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(post),
    },
    body: post,
  }).then((r) => ({ sid: r.sid || null }));
}

// Meta's limits for interactive messages. Anything past them is rejected, so
// a message that does not fit is sent as plain text instead.
const META_LIMITS = { body: 1024, buttons: 3, buttonTitle: 20, rows: 10, rowTitle: 24, rowDescription: 72, listButton: 20 };
const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/**
 * The Meta `interactive` object for tappable replies, or null when the
 * request cannot be one (no options, too many, an empty or oversized body).
 *
 * @param {object} interactive
 * @param {string} interactive.body                    text above the options
 * @param {Array<{id: string, title: string}>} [interactive.buttons]   up to 3
 * @param {{button: string, rows: Array<{id: string, title: string, description?: string}>}} [interactive.list]  up to 10 rows
 */
function metaInteractive(interactive) {
  const text = String(interactive?.body || '').trim();
  if (!text || text.length > META_LIMITS.body) return null;
  const usable = option => option && String(option.id || '').trim() && String(option.title || '').trim();
  const buttons = (interactive.buttons || []).filter(usable);
  if (buttons.length >= 1 && buttons.length <= META_LIMITS.buttons) {
    return {
      type: 'button',
      body: { text },
      action: {
        buttons: buttons.map(b => ({ type: 'reply', reply: { id: String(b.id), title: clip(b.title, META_LIMITS.buttonTitle) } })),
      },
    };
  }
  const rows = (interactive.list?.rows || []).filter(usable);
  if (rows.length >= 1 && rows.length <= META_LIMITS.rows && String(interactive.list.button || '').trim()) {
    return {
      type: 'list',
      body: { text },
      action: {
        button: clip(interactive.list.button, META_LIMITS.listButton),
        sections: [{
          rows: rows.map(r => ({
            id: String(r.id),
            title: clip(r.title, META_LIMITS.rowTitle),
            ...(r.description ? { description: clip(r.description, META_LIMITS.rowDescription) } : {}),
          })),
        }],
      },
    };
  }
  return null;
}

function sendViaMeta({ to, body, interactive = null }) {
  const { phoneNumberId, accessToken, graphVersion } = config.whatsapp;
  const payload = JSON.stringify({
    messaging_product: 'whatsapp',
    to: to.replace(/^\+/, ''),
    ...(interactive
      ? { type: 'interactive', interactive }
      : { type: 'text', text: { preview_url: false, body } }),
  });
  return httpsPost({
    hostname: 'graph.facebook.com',
    path: `/${graphVersion}/${phoneNumberId}/messages`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    body: payload,
  }).then((r) => ({ sid: r.messages?.[0]?.id || null }));
}

/**
 * Send a WhatsApp reply. Never throws — returns { success, messageId?, error? }.
 * @param {object} opts
 * @param {'twilio'|'meta'} opts.provider
 * @param {string} opts.to              - E.164 destination (no 'whatsapp:' prefix)
 * @param {string} opts.body            - the full reply as text; always sendable on its own
 * @param {object} [opts.interactive]   - tappable form of the same reply (Meta only), see metaInteractive
 * @param {number|null} [opts.organizationId]  - when set, the send is logged to sms_logs
 * @param {number|null} [opts.clientId]
 */
async function sendReply({ provider, to, body, interactive = null, organizationId = null, clientId = null }) {
  let result;
  const organizationState = await communicationPreferences.getOrganizationDeliveryState(organizationId);
  let clientContactEpoch = 0;
  try {
    if (!organizationState.active) {
      result = {
        success: false,
        sid: null,
        error: 'Organization is inactive.',
        code: 'ORGANIZATION_INACTIVE',
      };
    }
    if (!result && clientId !== null && clientId !== undefined) {
      const preference = await communicationPreferences.evaluateClientCommunication({
        organizationId,
        clientId,
        channel: 'whatsapp',
        destination: to,
        messageClass: 'support_reply',
      });
      if (!preference.allowed) {
        result = {
          success: false,
          sid: null,
          error: 'Client communication preference blocks this delivery.',
          code: preference.code,
        };
      } else {
        clientContactEpoch = Number(preference.contactEpoch || 0);
      }
    }
    const finalOrganizationState = await communicationPreferences.getOrganizationDeliveryState(organizationId);
    if (!result && (!finalOrganizationState.active
        || Number(finalOrganizationState.epoch) !== Number(organizationState.epoch))) {
      result = {
        success: false,
        sid: null,
        error: 'Organization delivery authorization changed.',
        code: 'ORGANIZATION_INACTIVE',
      };
    }
    if (!result && clientId !== null && clientId !== undefined) {
      const finalPreference = await communicationPreferences.evaluateClientCommunication({
        organizationId,
        clientId,
        channel: 'whatsapp',
        destination: to,
        messageClass: 'support_reply',
      });
      if (!finalPreference.allowed
          || Number(finalPreference.contactEpoch || 0) !== clientContactEpoch) {
        result = {
          success: false,
          sid: null,
          error: 'Client communication preference blocks this delivery.',
          code: finalPreference.allowed
            ? communicationPreferences.BLOCK_CODES.CONTACT_MISMATCH
            : finalPreference.code,
        };
      }
    }
    let sent;
    if (!result && provider === 'meta') {
      if (!config.whatsapp.phoneNumberId || !config.whatsapp.accessToken) {
        throw new Error('Meta WhatsApp outbound not configured (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN)');
      }
      // Tappable options when the reply has them. If Meta refuses that form,
      // the same reply goes as plain text: it always spells the options out.
      const tappable = interactive ? metaInteractive(interactive) : null;
      if (tappable) {
        try {
          sent = await sendViaMeta({ to, interactive: tappable });
        } catch (interactiveErr) {
          logger.warn({ err: interactiveErr, provider }, 'whatsapp: interactive reply refused — sending it as text');
        }
      }
      if (!sent) sent = await sendViaMeta({ to, body });
    } else if (!result && provider === 'twilio') {
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
        throw new Error('Twilio WhatsApp outbound not configured');
      }
      sent = await sendViaTwilio({ to, body });
    } else if (!result) {
      throw new Error(`Unsupported WhatsApp provider: ${provider}`);
    }
    if (!result) {
      result = { success: true, sid: sent.sid, error: null };
      if (provider === 'meta') await whatsappSettings().noteSendSuccess();
    }
  } catch (err) {
    result = { success: false, sid: null, error: err.message || String(err) };
    logger.warn({ err, to, provider }, 'whatsapp: outbound reply failed');
    // Shown on the WhatsApp settings screen, so a rejected token does not
    // stay hidden in this log.
    if (provider === 'meta') await whatsappSettings().noteSendFailure({ message: result.error, code: err.code });
  }

  // Log to sms_logs only when we know the org (bound client) — org is NOT NULL.
  if (organizationId) {
    try {
      const writeLog = () => db.query(
        `INSERT INTO sms_logs
           (organization_id, organization_epoch, client_id, client_contact_epoch, phone_number, channel, direction, message_body,
            provider, provider_message_id, status, error_code, error_message,
            message_class, sent_at)
         VALUES (?, ?, ?, ?, ?, 'whatsapp', 'outbound', ?, ?, ?, ?, ?, ?, 'support_reply', ?)`,
        [
          organizationId, organizationState.epoch || 0, clientId, clientContactEpoch, to, body, provider, result.sid,
          result.success ? 'sent' : 'failed',
          result.code || null,
          result.success ? null : result.error,
          result.success ? new Date() : null,
        ],
      );
      if (typeof db.withTenantContext === 'function') {
        await db.withTenantContext(Number(organizationId), writeLog);
      } else {
        await writeLog();
      }
    } catch (logErr) {
      logger.warn({ err: logErr }, 'whatsapp: sms_logs write failed');
    }
  }

  return {
    success: result.success,
    messageId: result.sid,
    error: result.error,
    ...(result.code && { code: result.code, skipped: true }),
  };
}

module.exports = { sendReply, metaInteractive, META_LIMITS };
