// =============================================================================
// VigaBSS 5.0 — WhatsApp bot: voice notes
// =============================================================================
// A customer who sends a voice note gets the same answer as if they had typed
// it. The note is downloaded from Meta, transcribed with the organization's
// OpenAI provider (llmProviderService.transcribe), and the text is handled by
// the bot like any message. The audio itself is never stored.
//
// Voice notes are transcribed only when the organization has the AI assistant
// on for WhatsApp: that switch is the organization's consent to send customer
// messages to its AI provider, and a recording is a customer message.
//
// transcribe() returns the text or null. Null covers every reason there is
// nothing to act on (assistant off, no OpenAI provider, over budget, a note
// too long or in a format the model does not take, Meta or the provider
// failing, silence) and the bot then asks the customer to type instead.
// =============================================================================

const https = require('https');
const config = require('../config');
const AiPolicy = require('../models/AiPolicy');
const supportAiWriter = require('./supportAiWriter');
const logger = require('../utils/logger').child({ service: 'whatsappVoice' });

// A two-minute voice note is about 300 KB. Past this the note is refused
// rather than paid for: nobody describes a support problem for ten minutes.
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
// What the bot will act on. A longer transcript is cut, like a long text.
const MAX_TRANSCRIPT_CHARS = 1500;
const TIMEOUT_MS = 15000;
// Meta serves media from these; the access token is sent nowhere else.
const MEDIA_HOST_RE = /(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net)$/i;

function get(url, token, { maxBytes }) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Meta answered HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error('media is larger than the limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Meta media request timed out')));
    req.on('error', reject);
  });
}

/**
 * Download a media object the customer sent, by its Meta media id.
 * @returns {Promise<{audio: Buffer, mimeType: string}>}
 */
async function downloadMetaMedia(mediaId, { fetch = get } = {}) {
  const { accessToken, graphVersion } = config.whatsapp;
  if (!accessToken) throw new Error('no WhatsApp access token');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(mediaId || ''))) throw new Error('invalid media id');

  // Step 1: the media object says where the file is (a short-lived URL).
  const meta = JSON.parse((await fetch(
    `https://graph.facebook.com/${graphVersion}/${mediaId}`, accessToken, { maxBytes: 64 * 1024 },
  )).toString('utf8'));
  if (Number(meta.file_size) > MAX_AUDIO_BYTES) throw new Error('media is larger than the limit');
  let target;
  try { target = new URL(String(meta.url || '')); } catch (err) { throw new Error('Meta returned no media URL', { cause: err }); }
  if (target.protocol !== 'https:' || !MEDIA_HOST_RE.test(target.hostname)) {
    throw new Error('Meta returned a media URL on an unexpected host');
  }
  // Step 2: the file itself, with the same token.
  const audio = await fetch(target.toString(), accessToken, { maxBytes: MAX_AUDIO_BYTES });
  return { audio, mimeType: String(meta.mime_type || '') };
}

/** May this organization's voice notes be sent for transcription? */
async function enabledFor(orgId) {
  if (!orgId) return false;
  const policy = await AiPolicy.findByOrgId(orgId);
  return supportAiWriter.enabledFor(policy, 'whatsapp');
}

/**
 * Whether this organization's voice notes are transcribed right now, and if
 * not, the first thing that stops them. For the settings screens: the bot's
 * "I couldn't listen" reply is the same whatever the cause.
 *
 * reason: 'not_connected'  WhatsApp is not connected through Meta's Cloud API
 *         'assistant_off'  the AI assistant is off
 *         'channel_off'    the assistant is not enabled for WhatsApp
 *         'no_provider'    no enabled OpenAI or OpenRouter provider
 *         'over_budget'    the monthly AI budget is used up
 *
 * @returns {Promise<{ready: boolean, reason: string|null, provider: {id: number, name: string, kind: string}|null, model: string|null}>}
 */
async function status(orgId, deps = {}) {
  const llm = deps.llm || require('./llmProviderService');
  const provider = orgId ? await llm.transcriptionProvider(orgId) : null;
  const shown = provider ? { id: provider.id, name: provider.name, kind: provider.kind } : null;
  const result = reason => ({ ready: !reason, reason, provider: shown, model: llm.transcriptionModelFor(provider) });

  const webhook = require('./whatsappWebhookService');
  if (webhook.detectProvider() !== 'meta' || !config.whatsapp.accessToken) return result('not_connected');
  const policy = orgId ? await AiPolicy.findByOrgId(orgId) : null;
  if (!policy || !Number(policy.enabled)) return result('assistant_off');
  if (!supportAiWriter.enabledFor(policy, 'whatsapp')) return result('channel_off');
  if (!provider) return result('no_provider');
  if (await require('./aiBudgetService').overBudget(orgId)) return result('over_budget');
  return result(null);
}

/**
 * The text of a voice note, or null when there is nothing to act on.
 * Never throws.
 *
 * @param {object} opts
 * @param {number} opts.orgId      the bound client's organization
 * @param {string} opts.provider   'meta' | 'twilio' (only Meta is supported)
 * @param {{id: string, mimeType?: string}} opts.audio
 * @param {string} [opts.locale]   the bot's language for this customer
 */
async function transcribe({ orgId, provider, audio, locale = null }, deps = {}) {
  try {
    if (provider !== 'meta' || !audio?.id) return null;
    if (!await enabledFor(orgId)) return null;
    const llm = deps.llm || require('./llmProviderService');
    if (!await llm.transcriptionProvider(orgId)) return null;

    const media = await (deps.download || downloadMetaMedia)(audio.id);
    const language = /^[a-z]{2}/i.test(String(locale || '')) ? String(locale).slice(0, 2).toLowerCase() : null;
    const result = await llm.transcribe({
      orgId, audio: media.audio, mimeType: media.mimeType || audio.mimeType || 'audio/ogg', language,
    });
    const text = String(result?.text || '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, MAX_TRANSCRIPT_CHARS) : null;
  } catch (err) {
    logger.warn({ err: err.message, orgId, code: err.code }, 'whatsappVoice: could not transcribe the voice note');
    return null;
  }
}

module.exports = { transcribe, status, downloadMetaMedia, enabledFor, MAX_AUDIO_BYTES, MAX_TRANSCRIPT_CHARS };
