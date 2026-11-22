// =============================================================================
// VigaBSS 5.0 — WhatsApp bot (identity / binding phase)
// =============================================================================
// The conversation brain for an inbound WhatsApp message. In this phase it only
// establishes identity: it links a phone number to a client via a portal code
// or an email OTP, and recognizes an already-bound number. Account capabilities
// (balance, report-a-problem, ...) arrive in the next phase and will replace the
// "already connected" placeholder with a capability menu.
//
// Anti-enumeration: an email that isn't on file gets the SAME reply as one that
// is (the code is only actually sent for a unique match). We never confirm to an
// unverified number whether an account exists.
// =============================================================================

const config = require('../config');
const db = require('../config/database');
const logger = require('../utils/logger');
const wa = require('./whatsappService');
const cap = require('./whatsappCapabilityService');
const understanding = require('./whatsappUnderstanding');
const { businessToday, addDays } = require('../utils/businessDate');

// Coarse per-phone throttle for UNBOUND numbers (binding-attempt flood / code
// brute-force). Legitimate linking is 1-3 messages; 20/hr is generous.
const UNBOUND_MSG_LIMIT_PER_HOUR = 20;
// Bound clients navigate menus, so a looser cap — but still bounds a hijacked or
// abusive bound thread (each message can open at most one ticket).
const BOUND_MSG_LIMIT_PER_HOUR = 40;
// Hard cap on WhatsApp-originated tickets per client per hour (anti ticket-flood).
const WHATSAPP_TICKET_CAP_PER_HOUR = 5;
// Hard cap on WhatsApp-originated write-action requests (Wi-Fi reset, visit) per
// client per hour — bounds a hijacked bound thread spamming password resets.
const WHATSAPP_ACTION_CAP_PER_HOUR = 3;

const { AsyncLocalStorage } = require('async_hooks');
const { t } = require('../utils/i18n');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Subscriber-facing copy lives in src/locales/{en,es,pt-BR}.json under
// whatsappBot (ASY-40). The language is resolved once per inbound message (the
// linked client's organization, or the install default before linking) and
// carried in an AsyncLocalStorage store, so the handlers keep using MSG.x.
const botLocaleStore = new AsyncLocalStorage();
const currentLocale = () => botLocaleStore.getStore() || wa.defaultBotLocale?.() || 'es';
const tr = (key, vars) => t(`whatsappBot.${key}`, currentLocale(), vars);
const withName = (name) => (name ? ` ${name}` : '');

const MSG_FORMATTERS = {
  bindOk: (name) => tr('bindOk', { name: name ? `, ${name}` : '' }),
  menu: (name) => tr('menu', { name: withName(name) }),
  greeting: (name) => tr('greeting', { name: withName(name) }),
  pickService: (contracts) => tr('pickService', { list: contracts.map((c, i) => `${i + 1}) ${c.label}`).join('\n') }),
  problemLogged: (id) => tr('problemLogged', { id }),
  humanLogged: (id) => tr('humanLogged', { id }),
  wifiConfirm: (email) => tr('wifiConfirm', { email: email || tr('emailOnFile') }),
  wifiApplied: (email) => tr('wifiApplied', { email }),
  wifiFiled: (id) => tr('wifiFiled', { id }),
  visitLogged: (id, date, slot) => tr('visitLogged', { id, date, slot: slot ? tr(`slots.${slot}`) : '' }),
};

const MSG = new Proxy({}, {
  get(_target, key) {
    if (typeof key !== 'string') return undefined;
    return MSG_FORMATTERS[key] || tr(key);
  },
});

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// A code message is ONLY a code — both the portal deep-link and the OTP flow send
// the code as the whole message. Require the trimmed body to be digits (with
// optional spaces/dashes), 6-8 digits total. Anchoring avoids swallowing a
// numeric-suffixed email (carlos123456@x.com) or a texted phone number as a code.
function extractCode(body) {
  const t = String(body || '').trim();
  if (!/^[\d\s-]+$/.test(t)) return null;
  const digits = t.replace(/\D/g, '');
  return digits.length >= 6 && digits.length <= 8 ? digits : null;
}

function isUnlinkCommand(body) {
  return /^\s*(unlink|desvincular|desconectar)\s*$/i.test(body || '');
}

// The bound client's organization may keep its own database (isolated mode):
// everything about that client is read and written there, while the
// install-wide WhatsApp tables stay on the primary (whatsappService pins
// them). Inbound traffic arrives with no tenant context at all (SUP-12).
function inClientDatabase(organizationId, fn) {
  return organizationId && typeof db.withTenantContext === 'function'
    ? db.withTenantContext(organizationId, fn)
    : fn();
}

async function clientFirstName(clientId, organizationId = null) {
  try {
    const [rows] = await inClientDatabase(organizationId, () => db.query('SELECT name FROM clients WHERE id = ? LIMIT 1', [clientId]));
    return firstName(rows[0]?.name);
  } catch (_e) {
    return '';
  }
}

/**
 * Best-effort email-OTP send. Resolves EXACTLY ONE non-deleted client by email
 * (0 or >1 matches -> no send, to avoid cross-tenant ambiguity and enumeration).
 * Never throws; the caller has already produced the uniform reply.
 */
async function maybeSendEmailOtp({ phone, email }) {
  try {
    if (await wa.emailCodeBudgetExceeded(phone)) return;
    const [clients] = await db.query(
      'SELECT id, organization_id, name, email FROM clients WHERE email = ? AND deleted_at IS NULL LIMIT 2',
      [email],
    );
    if (clients.length !== 1) return;
    const client = clients[0];
    // Per-target-inbox budget (the per-phone budget above protects the sender,
    // not the victim's inbox against a number-cycling attacker).
    if (await wa.clientEmailCodeBudgetExceeded(client.id, client.organization_id ?? null)) return;
    // No new codes for an account whose linking is locked for the day (SUP-10).
    if (await wa.clientLinkGuessesExhausted(client.id)) return;

    const code = await wa.createVerification({
      organizationId: client.organization_id,
      phone,
      purpose: 'link_email',
      clientId: client.id,
      channel: 'email',
      length: wa.EMAIL_CODE_LENGTH,
    });

    const messageOutbox = require('./messageOutbox');
    const templates = require('../views/emailTemplates');
    const tpl = templates.whatsappLinkCodeEmail({
      userName: client.name,
      code,
      expiresIn: `${config.whatsapp.linkCodeTtlMinutes} minutes`,
    });
    // Outbox (ASY-33), sensitive: the code is a credential.
    messageOutbox.queueEmail({
      to: client.email,
      subject: tpl.subject,
      html: tpl.html,
      organizationId: client.organization_id,
      clientId: client.id,
      messageClass: 'security',
      emailFunction: 'general',
      sensitive: true,
      sourceType: 'whatsapp_link_code',
    })
      .then((r) => { if (!r || !r.queued) logger.warn('whatsapp: link-code email could not be queued'); })
      .catch((e) => logger.error({ err: e }, 'whatsapp: link-code email threw'));
  } catch (err) {
    logger.error({ err }, 'whatsapp: maybeSendEmailOtp failed');
  }
}

/**
 * Handle one inbound message. Performs binding side effects and returns the text
 * to reply with.
 * @param {object} opts
 * @param {string} opts.phone  - normalized E.164
 * @param {string} opts.body
 * @param {{id: string, mimeType?: string}} [opts.audio]  a voice note, when the message is one
 * @param {string} [opts.provider]  the inbound provider ('meta' | 'twilio'), needed to fetch a voice note
 * @returns {Promise<{reply: string, clientId?: number, interactive?: object, transcript?: string}>}
 */
async function handleInbound({ phone, body, audio = null, provider = null }) {
  // 1. Already bound? Run the bound-client bot (menu + read-only capabilities)
  // in the client's organization's language.
  const binding = await wa.resolveBinding(phone);
  if (binding) {
    const locale = (await wa.botLocale?.(binding.organizationId)) || null;
    return botLocaleStore.run(locale, () =>
      inClientDatabase(binding.organizationId, () => handleBound({ phone, body, binding, audio, provider })));
  }
  return botLocaleStore.run(null, () => handleUnbound({ phone, body }));
}

async function handleUnbound({ phone, body }) {

  // 2. Unbound — throttle binding attempts per phone.
  const recent = await wa.recentInboundCount(phone, 60);
  if (recent > UNBOUND_MSG_LIMIT_PER_HOUR) {
    return { reply: MSG.cooldown };
  }

  const trimmed = String(body || '').trim();
  const code = extractCode(trimmed);

  // 2a. A code. Portal codes are 8 digits, email OTPs 6 — route by length so a
  // pending email OTP can't shadow a valid portal code, and typing one never
  // pollutes the other's attempt counter.
  if (code) {
    if (code.length === wa.PORTAL_CODE_LENGTH) {
      const portalAttempt = await wa.verifyPortalCode({ code });
      if (portalAttempt.ok) {
        await wa.bindNumber({ organizationId: portalAttempt.organizationId, clientId: portalAttempt.clientId, phone, via: 'portal' });
        return { reply: MSG.bindOk(await clientFirstName(portalAttempt.clientId, portalAttempt.organizationId)), clientId: portalAttempt.clientId };
      }
      return { reply: MSG.codeBad };
    }
    const emailAttempt = await wa.verifyPhoneCode({ phone, purpose: 'link_email', code });
    if (emailAttempt.ok) {
      await wa.bindNumber({ organizationId: emailAttempt.organizationId, clientId: emailAttempt.clientId, phone, via: 'email_otp' });
      return { reply: MSG.bindOk(await clientFirstName(emailAttempt.clientId, emailAttempt.organizationId)), clientId: emailAttempt.clientId };
    }
    if (emailAttempt.reason === 'locked') return { reply: MSG.locked };
    if (emailAttempt.reason === 'mismatch') return { reply: MSG.codeMismatch };
    // no pending email OTP — last resort, a portal code of a non-standard length.
    const portalAttempt = await wa.verifyPortalCode({ code });
    if (portalAttempt.ok) {
      await wa.bindNumber({ organizationId: portalAttempt.organizationId, clientId: portalAttempt.clientId, phone, via: 'portal' });
      return { reply: MSG.bindOk(await clientFirstName(portalAttempt.clientId, portalAttempt.organizationId)), clientId: portalAttempt.clientId };
    }
    return { reply: MSG.codeBad };
  }

  // 2b. An email — start email-OTP (uniform reply regardless of match).
  if (EMAIL_RE.test(trimmed)) {
    await maybeSendEmailOtp({ phone, email: trimmed });
    return { reply: MSG.emailSent };
  }

  // 2c. Anything else — instructions.
  return { reply: MSG.welcome };
}

// ---------------------------------------------------------------------------
// Bound-client bot: menu + read-only capabilities + report-a-problem flow
// ---------------------------------------------------------------------------

/**
 * Route a free-text message through the AI support engine.
 *
 * Continuity matters on WhatsApp: a subscriber describes a fault across three
 * messages. The support_conversations id is kept in the bot's own conversation
 * state so follow-ups continue ONE thread rather than opening a new
 * conversation — and therefore a new diagnostic context — per message.
 *
 * channel='whatsapp' is passed through: support_conversations.channel is a
 * free-text VARCHAR defaulting to 'web', so the engine was already
 * channel-aware and nobody had connected the second channel. No migration.
 *
 * THE HANDOFF THRESHOLD IS NOT A NEW DECISION. supportConversationService
 * already owns it (LOW_CONFIDENCE_THRESHOLD, MAX_LOW_CONFIDENCE_MESSAGES, plus
 * explicit human-request / negative-sentiment / billing-dispute triggers).
 * Inventing a second threshold for WhatsApp would mean the same sentence
 * escalates in the portal and not here.
 *
 * Returns the reply text, or null to fall back to the menu. EVERY failure
 * returns null: an LLM outage, a missing provider, a DB error — none of them
 * may surface as an error message to a customer on WhatsApp.
 */
async function tryAiSupport({ phone, orgId, clientId, text, state, natural = false }) {
  try {
    const support = require('./supportConversationService');
    // Continue the client's escalated WhatsApp conversation, if one is open,
    // rather than starting a new one that can escalate again into another
    // ticket (SUP-09).
    let priorId = state?.context?.supportConversationId || null;
    if (!priorId) {
      const [[open]] = await db.query(
        `SELECT id FROM support_conversations
          WHERE client_id = ? AND organization_id <=> ? AND channel = 'whatsapp' AND status = 'escalated'
          ORDER BY id DESC LIMIT 1`,
        [clientId, orgId],
      );
      priorId = open ? open.id : null;
    }

    let result;
    if (priorId) {
      result = await support.sendMessage({ conversationId: priorId, orgId, content: text, clientId });
    } else {
      result = await support.startConversation({ orgId, clientId, channel: 'whatsapp', message: text });
    }
    if (!result?.conversation) return null;

    const conv = result.conversation;
    const messages = result.messages || [];

    // An escalated conversation gets no AI reply by design, so say a human is
    // coming rather than returning the greeting and looking like a non-answer.
    if (conv.status === 'escalated') {
      // Keep the thread: the next message appends to it, and a repeated
      // escalation of an already escalated conversation is a no-op.
      await wa.setConversationState(phone, clientId, 'ai_support', { supportConversationId: conv.id });
      return MSG.aiEscalated;
    }

    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant?.content) return null;

    // Remember the thread so the next message continues it.
    await wa.setConversationState(phone, clientId, 'ai_support', { supportConversationId: conv.id });
    // In a natural conversation the answer stands on its own; the menu bot
    // adds how to get back to the menu.
    return natural ? lastAssistant.content : `${lastAssistant.content}\n\n_${MSG.aiMenuHint}_`;
  } catch (err) {
    logger.warn({ err: err.message, clientId }, 'WhatsApp AI support unavailable — falling back to the menu');
    return null;
  }
}

function isMenuCommand(text) {
  return /^\s*(menu|men[uú]|cancel|cancelar|salir|0)\s*$/i.test(text || '');
}

/** Map a bound client's message to an intent. Unknown/greeting -> 'menu'. */
function parseIntent(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^1$|balance|saldo/.test(t)) return 'balance';
  if (/^2$|\bplan\b|servicio|service|velocidad|speed/.test(t)) return 'plan';
  if (/^3$|invoice|factura|recibo|\bbill/.test(t)) return 'invoices';
  if (/^4$|report|problema|reportar|falla|issue|not working|no funciona/.test(t)) return 'report';
  if (/^5$|wi-?fi|contrase|clave|password/.test(t)) return 'wifi';
  if (/^6$|visit|visita|t[eé]cnico|technician|schedule|agenda|cita/.test(t)) return 'visit';
  if (/^7$|human|agente|asesor|person|talk|hablar/.test(t)) return 'human';
  return 'menu';
}

/**
 * Is this free text worth sending to the §21 AI support engine?
 *
 * The bot is a fixed numbered menu, so "mi internet se cae cada noche desde el
 * martes" fell through parseIntent to 'menu' and got a list of numbers back —
 * the channel most Mexican customers prefer had the least capable support path,
 * while a full intent-classification + diagnostics engine sat unused next door.
 *
 * The bar is deliberately conservative. A bare greeting, a stray number or a
 * one-word reply is menu navigation, not a support question, and routing those
 * to an LLM would spend money to answer "hola" worse than the menu does.
 */
function isFreeTextQuestion(text) {
  const t = String(text || '').trim();
  if (t.length < 12) return false;                       // "hola", "1", "gracias"
  if (/^\d+$/.test(t)) return false;                     // menu selection
  if (/^\s*(hola|hi|hello|buenas|buenos d[ií]as|gracias|thanks|ok|s[ií]|no)\b/i.test(t)
      && t.split(/\s+/).length <= 3) return false;       // short pleasantry
  return t.split(/\s+/).length >= 3;                     // a sentence, not a keyword
}

function isConfirmCommand(text) {
  return /^\s*(confirm|confirmar|s[ií]|yes)\s*$/i.test(text || '');
}

function parseSlot(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^1$|morning|mañana|manana/.test(t)) return 'morning';
  if (/^2$|afternoon|tarde/.test(t)) return 'afternoon';
  if (/^3$|evening|noche/.test(t)) return 'evening';
  return null;
}
function parseVisitDate(text) {
  const m = String(text || '').match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (!m) return null;
  const [iso, y, mo, d] = m;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  // Reject overflow days that V8 silently rolls over (Feb 30 -> Mar 2): the
  // round-trip must match the literal components.
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() + 1 !== Number(mo) || dt.getUTCDate() !== Number(d)) return null;
  // Reject past dates (a visit can't be scheduled in the past); today, in the
  // business time zone, is allowed.
  if (iso < businessToday()) return null;
  return iso;
}

function isCancelCommand(text) {
  return /^\s*(cancel|cancelar|no)\s*$/i.test(text || '');
}

// ---------------------------------------------------------------------------
// Replies with tappable options
// ---------------------------------------------------------------------------
// `reply` is always the whole answer as text (what Twilio, or Meta after a
// refused interactive message, sends). `interactive` is the same answer as
// WhatsApp buttons or a list. Every option id is something the customer could
// also type ("1", "confirm", "morning", a date), so a tap needs no code path
// of its own.

const button = (id, key) => ({ id, title: tr(`buttons.${key}`) });

function menuReply(name) {
  return {
    reply: MSG.menu(name),
    interactive: {
      body: tr('menuIntro', { name: withName(name) }),
      list: {
        button: tr('buttons.options'),
        rows: [1, 2, 3, 4, 5, 6, 7].map(n => ({ id: String(n), title: tr(`menuRows.${n}`) })),
      },
    },
  };
}

function pickReply(contracts, { invalid = false } = {}) {
  return {
    reply: invalid ? MSG.pickInvalid : MSG.pickService(contracts),
    // Past ten rows WhatsApp has no list; the numbered text is the reply.
    interactive: contracts.length <= 10 ? {
      body: tr('pickServiceBody'),
      list: {
        button: tr('buttons.options'),
        rows: contracts.map((c, i) => ({ id: String(i + 1), title: `${i + 1}. ${c.planName || c.label}`, description: c.label })),
      },
    } : null,
  };
}

function wifiConfirmReply(emailMasked, { again = false } = {}) {
  return {
    reply: again ? MSG.confirmInvalid : MSG.wifiConfirm(emailMasked),
    interactive: {
      body: again ? tr('wifiConfirmAgainBody') : tr('wifiConfirmBody', { email: emailMasked || tr('emailOnFile') }),
      buttons: [button('confirm', 'confirm'), button('cancel', 'cancel')],
    },
  };
}

function visitDateReply(natural, { again = false } = {}) {
  const today = businessToday();
  const text = natural
    ? tr(again ? 'visitDateInvalidNatural' : 'askVisitDateNatural')
    : (again ? MSG.visitDateInvalid : MSG.askVisitDate);
  return {
    reply: text,
    interactive: {
      body: text,
      buttons: [{ id: addDays(today, 1), title: tr('buttons.tomorrow') }, { id: addDays(today, 2), title: tr('buttons.dayAfter') }],
    },
  };
}

function slotReply() {
  return {
    reply: MSG.askVisitSlot,
    interactive: {
      body: tr('askVisitSlotBody'),
      buttons: [button('morning', 'morning'), button('afternoon', 'afternoon'), button('evening', 'evening')],
    },
  };
}

/** Masked email on file, or null when none — gates the Wi-Fi reset (must deliver the new PSK). */
async function clientEmailMasked(clientId) {
  try {
    const [rows] = await db.query('SELECT email FROM clients WHERE id = ? LIMIT 1', [clientId]);
    const email = rows[0]?.email;
    return email ? cap.maskEmail(email) : null;
  } catch (_e) {
    return null;
  }
}

async function startReport(phone, orgId, clientId) {
  const contracts = await cap.getActiveContracts(orgId, clientId);
  if (contracts.length > 1) {
    await wa.setConversationState(phone, clientId, 'await_contract_pick', { contracts });
    return pickReply(contracts);
  }
  await wa.setConversationState(phone, clientId, 'await_problem_desc', { contract: contracts[0] || null });
  return { reply: MSG.askProblem };
}

async function startWifiReset(phone, orgId, clientId) {
  const contracts = await cap.getActiveContracts(orgId, clientId);
  if (contracts.length === 0) return { reply: MSG.noService };
  // Must be able to deliver the new PSK out-of-band, or the client is locked out.
  const emailMasked = await clientEmailMasked(clientId);
  if (!emailMasked) return { reply: MSG.wifiNoEmail };
  if (contracts.length > 1) {
    await wa.setConversationState(phone, clientId, 'await_wifi_pick', { contracts, emailMasked });
    return pickReply(contracts);
  }
  await wa.setConversationState(phone, clientId, 'await_wifi_confirm', { contract: contracts[0] || null, emailMasked });
  return wifiConfirmReply(emailMasked);
}

async function applyWifiReset(phone, clientId, orgId, contract) {
  await wa.clearConversationState(phone);
  if (await cap.recentServiceRequestCount(orgId, clientId, 'wifi_password_change') >= WHATSAPP_ACTION_CAP_PER_HOUR) {
    return { reply: MSG.actionCapped, clientId };
  }
  // resetWifiPassword delivers the new PSK by email FIRST and only applies on
  // confirmed delivery, so its result is authoritative — never claim "emailed"
  // unless it actually was.
  const r = await cap.resetWifiPassword({ orgId, clientId, contract });
  if (!r.ok) {
    if (r.reason === 'no_email') return { reply: MSG.wifiNoEmail, clientId };
    if (r.reason === 'contract_gone') return { reply: MSG.noService, clientId };
    return { reply: MSG.wifiEmailFailed, clientId }; // email_failed
  }
  if (r.applied) return { reply: MSG.wifiApplied(r.emailMasked), clientId };
  return { reply: MSG.wifiFiled(r.requestId), clientId };
}

async function startVisit(phone, orgId, clientId, natural = false) {
  const contracts = await cap.getActiveContracts(orgId, clientId);
  if (contracts.length === 0) return { reply: MSG.noService };
  if (contracts.length > 1) {
    await wa.setConversationState(phone, clientId, 'await_visit_pick', { contracts });
    return pickReply(contracts);
  }
  await wa.setConversationState(phone, clientId, 'await_visit_date', { contract: contracts[0] || null });
  return visitDateReply(natural);
}

async function finishVisit(phone, orgId, clientId, contract, date, slot) {
  await wa.clearConversationState(phone);
  if (await cap.recentServiceRequestCount(orgId, clientId, 'visit_schedule') >= WHATSAPP_ACTION_CAP_PER_HOUR) {
    return { reply: MSG.actionCapped, clientId };
  }
  const id = await cap.scheduleVisit({ orgId, clientId, contract, preferredDate: date, slot });
  return { reply: MSG.visitLogged(id, date, slot), clientId };
}

/** The contract the customer picked: by its number, or, with the assistant on, by how they described it. */
async function pickContract(orgId, ai, text, contracts) {
  const byNumber = contracts[parseInt(text.replace(/\D/g, ''), 10) - 1];
  if (byNumber || !ai || !text) return byNumber || null;
  const index = await understanding.readChoice(orgId, ai, text, contracts.map(c => c.label));
  return index === null ? null : contracts[index];
}

/**
 * Carry out one of the bot's capabilities. `reword` is the customer's own
 * message when the assistant should phrase a read-only answer for it; the
 * facts are always the rule-based text.
 */
async function runIntent(intent, { phone, orgId, clientId, natural = false, reword = null }) {
  const say = async (facts) => ({
    reply: (reword && await understanding.word(orgId, reword, facts)) || facts,
    clientId,
  });
  switch (intent) {
    case 'balance': return say(await cap.balanceText(orgId, clientId, currentLocale()));
    case 'plan': return say(await cap.planText(orgId, clientId, currentLocale()));
    case 'invoices': return say(await cap.invoicesText(orgId, clientId, currentLocale()));
    case 'report': return { ...(await startReport(phone, orgId, clientId)), clientId };
    case 'wifi': return { ...(await startWifiReset(phone, orgId, clientId)), clientId };
    case 'visit': return { ...(await startVisit(phone, orgId, clientId, natural)), clientId };
    case 'human': {
      await wa.clearConversationState(phone);
      if (await cap.recentWhatsappTicketCount(orgId, clientId) >= WHATSAPP_TICKET_CAP_PER_HOUR) {
        return { reply: MSG.ticketCapped, clientId };
      }
      const id = await cap.createHumanHandoffTicket({ orgId, clientId });
      return { reply: MSG.humanLogged(id), clientId };
    }
    default: return { ...menuReply(await clientFirstName(clientId)), clientId };
  }
}

async function handleBound({ phone, body, binding, audio = null, provider = null }) {
  const clientId = binding.clientId;
  // The org comes from the resolved link row, never from the inbound payload.
  const orgId = binding.organizationId ?? null;

  // A voice note is answered like the same words typed. It is transcribed
  // only for a linked customer (the organization, and so whose provider and
  // budget, is known) and only when that organization allows it.
  if (audio && !String(body || '').trim()) {
    await wa.touchBinding(binding.linkId);
    if (await wa.recentInboundCount(phone, 60) > BOUND_MSG_LIMIT_PER_HOUR) {
      return { reply: MSG.cooldown, clientId };
    }
    const transcript = await require('./whatsappVoice').transcribe({ orgId, provider, audio, locale: currentLocale() });
    if (!transcript) return { reply: MSG.voiceUnavailable, clientId };
    return { ...(await handleBoundText({ phone, text: transcript, binding })), transcript };
  }
  return handleBoundText({ phone, text: String(body || '').trim(), binding });
}

async function handleBoundText({ phone, text, binding }) {
  const clientId = binding.clientId;
  const orgId = binding.organizationId ?? null;

  await wa.touchBinding(binding.linkId);

  if (isUnlinkCommand(text)) {
    await wa.revokeLink({ clientId, organizationId: orgId, linkId: binding.linkId });
    await wa.clearConversationState(phone);
    return { reply: MSG.unlinked, clientId };
  }

  // Throttle a flooding/hijacked bound thread (bounds ticket creation too).
  if (await wa.recentInboundCount(phone, 60) > BOUND_MSG_LIMIT_PER_HOUR) {
    return { reply: MSG.cooldown, clientId };
  }

  let state = await wa.getConversationState(phone);
  // A number can be re-bound to a DIFFERENT client (recycled number / staff
  // re-link). Never carry a prior client's flow state across that rebind, or a
  // stale contract context would leak into the new client's ticket.
  if (state && state.clientId !== null && state.clientId !== undefined
      && Number(state.clientId) !== Number(clientId)) {
    await wa.clearConversationState(phone);
    state = null;
  }

  // The organization's assistant, when it is on for WhatsApp: the customer can
  // then answer in their own words. null = the numbered menu bot, unchanged.
  const ai = await understanding.availableFor(orgId) || null;
  const turn = { phone, orgId, clientId, natural: Boolean(ai) };

  // MENU/cancel always escapes an in-progress flow.
  if (state && isMenuCommand(text)) {
    await wa.clearConversationState(phone);
    if (ai && isCancelCommand(text)) return { reply: MSG.cancelled, clientId };
    return { ...menuReply(await clientFirstName(clientId)), clientId };
  }

  // In an active flow — the message is the flow's input.
  if (state && ['await_contract_pick', 'await_wifi_pick', 'await_visit_pick'].includes(state.state)) {
    const contracts = state.context?.contracts || [];
    const chosen = await pickContract(orgId, ai, text, contracts);
    if (!chosen) return { ...pickReply(contracts, { invalid: true }), clientId };
    if (state.state === 'await_contract_pick') {
      await wa.setConversationState(phone, clientId, 'await_problem_desc', { contract: chosen });
      return { reply: MSG.askProblem, clientId };
    }
    if (state.state === 'await_wifi_pick') {
      await wa.setConversationState(phone, clientId, 'await_wifi_confirm', { contract: chosen, emailMasked: state.context?.emailMasked });
      return { ...wifiConfirmReply(state.context?.emailMasked), clientId };
    }
    await wa.setConversationState(phone, clientId, 'await_visit_date', { contract: chosen });
    return { ...visitDateReply(turn.natural), clientId };
  }
  if (state && state.state === 'await_problem_desc') {
    await wa.clearConversationState(phone);
    if (await cap.recentWhatsappTicketCount(orgId, clientId) >= WHATSAPP_TICKET_CAP_PER_HOUR) {
      return { reply: MSG.ticketCapped, clientId };
    }
    const id = await cap.createProblemTicket({ orgId, clientId, description: text, contract: state.context?.contract || null });
    return { reply: MSG.problemLogged(id), clientId };
  }
  if (state && state.state === 'await_wifi_confirm') {
    // The reset only ever runs on a clear yes: the fixed word, the button, or
    // the assistant reading the customer's answer as agreement.
    let answer = isConfirmCommand(text) ? 'yes' : (isCancelCommand(text) ? 'no' : null);
    if (!answer && ai && text) answer = await understanding.readConfirm(orgId, ai, text);
    if (answer === 'yes') return applyWifiReset(phone, clientId, orgId, state.context?.contract || null);
    if (answer === 'no') {
      await wa.clearConversationState(phone);
      return { reply: MSG.cancelled, clientId };
    }
    return { ...wifiConfirmReply(state.context?.emailMasked, { again: true }), clientId };
  }
  if (state && state.state === 'await_visit_date') {
    const contract = state.context?.contract || null;
    let date = parseVisitDate(text);
    let slot = null;
    if (!date && ai && text) {
      // "mañana en la tarde", "el viernes": the day, and the time if given.
      const read = await understanding.readVisit(orgId, ai, text, businessToday());
      date = read?.date ? parseVisitDate(read.date) : null;
      slot = date ? (read.slot || null) : null;
    }
    if (!date) return { ...visitDateReply(turn.natural, { again: true }), clientId };
    if (slot) return finishVisit(phone, orgId, clientId, contract, date, slot);
    await wa.setConversationState(phone, clientId, 'await_visit_slot', { contract, date });
    return { ...slotReply(), clientId };
  }
  if (state && state.state === 'await_visit_slot') {
    let slot = parseSlot(text);
    if (!slot && ai && text) slot = (await understanding.readVisit(orgId, ai, text, businessToday()))?.slot || null;
    if (!slot) return { ...slotReply(), clientId };
    return finishVisit(phone, orgId, clientId, state.context?.contract || null, state.context?.date, slot);
  }

  // No active flow. A menu number (typed, or tapped in the list) always works.
  if (/^[1-7]$/.test(text)) return runIntent(parseIntent(text), turn);

  // With the assistant on, the customer writes what they need and the model
  // says which capability that is. It only picks from a fixed list; when it
  // cannot answer (or the call fails) the menu bot below takes over.
  if (ai && text) {
    const intent = await understanding.readIntent(orgId, ai, text);
    if (intent) return naturalTurn(intent, { ...turn, text, state });
  }

  // Before falling back to the numbered menu, give real
  // free text to the §21 engine — intent classification, diagnostics against
  // the actual account and connection, and confidence-scored escalation. The
  // menu stays as the fallback for everything else.
  // FREE TEXT WINS OVER KEYWORD MATCHING, and that ordering is the point.
  // parseIntent matches bare words anywhere in the message, so "no tengo
  // servicio desde ayer" hits `servicio` and "y tambien se cae el wifi" hits
  // `wifi` — both would have been answered with a canned menu response instead
  // of reaching the engine. Someone who writes a SENTENCE wants an answer, not
  // a plan summary; someone who types `2` wants the menu.
  if (isFreeTextQuestion(text)) {
    const aiReply = await tryAiSupport({ phone, orgId, clientId, text, state });
    if (aiReply) return { reply: aiReply, clientId };
    // Fall through to the menu when the engine is unavailable — a bot that
    // apologises for an internal error is worse than one that offers a menu.
  }

  // No active flow — parse an intent.
  return runIntent(parseIntent(text), turn);
}

// How many messages in a row the assistant may fail to understand before the
// customer is shown the menu instead of being asked to rephrase again.
const MAX_MISSES = 2;

/**
 * One turn of the natural conversation, for a message outside any flow whose
 * intent the assistant has named.
 */
async function naturalTurn(intent, { phone, orgId, clientId, text, state }) {
  const missed = async () => {
    const misses = Number(state?.context?.misses || 0) + 1;
    if (misses >= MAX_MISSES) {
      await wa.clearConversationState(phone);
      return { ...menuReply(await clientFirstName(clientId)), clientId };
    }
    await wa.setConversationState(phone, clientId, state?.state || 'chat', { ...(state?.context || {}), misses });
    return { reply: MSG.notUnderstood, clientId };
  };

  if (intent === 'greeting') return { reply: MSG.greeting(await clientFirstName(clientId)), clientId };
  if (intent === 'thanks') return { reply: MSG.youreWelcome, clientId };
  if (intent === 'unclear') return missed();
  if (intent === 'question') {
    // A described problem or a real question: the support engine checks the
    // account and the connection, answers, and hands off to staff when it
    // should.
    const answer = await tryAiSupport({ phone, orgId, clientId, text, state, natural: true });
    return answer ? { reply: answer, clientId } : missed();
  }
  return runIntent(intent, { phone, orgId, clientId, natural: true, reword: text });
}

module.exports = { handleInbound, UNBOUND_MSG_LIMIT_PER_HOUR };
