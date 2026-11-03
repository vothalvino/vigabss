// =============================================================================
// VigaBSS 5.0 — Message outbox: one durable queue for every outgoing message
// =============================================================================
// Email, SMS, WhatsApp and portal push are written to message_outbox first and
// delivered by the message_outbox task (and, with Redis, a 'message-outbox'
// job right after enqueue). One set of rules for every channel (ASY-33):
//
//   - The organization and client consent are checked at enqueue and again by
//     the transport immediately before the provider call; a block is 'skipped'
//     (no provider I/O), never a failure to retry.
//   - A row is claimed ('claimed') before any I/O and moved to 'sending' just
//     before the provider call. A stale claim proves nothing was sent and is
//     requeued; a stale 'sending' may have reached the provider and becomes
//     'outcome_unknown', which only staff can retry.
//   - A failure that provably sent nothing is retried with backoff until
//     max_attempts, then 'failed'. Email is retried after a timeout too (a
//     rare duplicate email beats a lost dunning notice); SMS and WhatsApp are
//     not, because a duplicate costs money and an SMS timeout may have sent.
//   - Each organization gets a per-minute budget per channel
//     (OUTBOX_RATE_<CHANNEL>_PER_MINUTE); the rest wait for the next minute.
//
// Delivery is at-least-once for email and push and at-most-once for SMS and
// WhatsApp. Producers that must not send twice pass a dedupe_key.
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'messageOutbox' });
const { noteOutboxMessage, noteOutboxBacklog } = require('../utils/opsMetrics');
const { AppError, NotFoundError, ValidationError } = require('../utils/errors');
const communicationPreferences = require('./clientCommunicationPreferenceService');

const CHANNELS = Object.freeze(['email', 'sms', 'whatsapp', 'push']);
const PRIORITY = Object.freeze({ security: 1, transactional: 3, support_reply: 4, marketing: 8 });
const OPERATIONAL_PRIORITY = 2;
const BACKOFF_MINUTES = Object.freeze([1, 5, 15, 60, 240]);
const CLAIM_STALE_MINUTES = 5;
const SENDING_STALE_MINUTES = 15;
const BATCH_SIZE = 100;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_RATE_PER_MINUTE = Object.freeze({ email: 120, sms: 30, whatsapp: 30, push: 300 });
const RETRYABLE_FROM = Object.freeze(['failed', 'outcome_unknown', 'cancelled']);
const CANCELLABLE_FROM = Object.freeze(['queued', 'failed', 'outcome_unknown']);

function rateLimit(channel) {
  const raw = Number.parseInt(process.env[`OUTBOX_RATE_${channel.toUpperCase()}_PER_MINUTE`], 10);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_RATE_PER_MINUTE[channel];
}

// ---------------------------------------------------------------------------
// Scope helpers (isolated tenants keep their rows in their own database)
// ---------------------------------------------------------------------------

function withTenant(organizationId, callback) {
  return organizationId === null || organizationId === undefined
    || typeof db.withTenantContext !== 'function'
    ? callback()
    : db.withTenantContext(Number(organizationId), callback);
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

function encodeAttachments(attachments) {
  if (!attachments || attachments.length === 0) return null;
  let total = 0;
  const encoded = attachments.map((a) => {
    const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content ?? ''), 'utf8');
    total += content.length;
    return { filename: a.filename, contentType: a.contentType || null, content: content.toString('base64') };
  });
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new ValidationError(`Email attachments exceed ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
  }
  return encoded;
}

function decodeAttachments(payload) {
  const list = payload?.attachments;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.map(a => ({
    filename: a.filename,
    ...(a.contentType && { contentType: a.contentType }),
    content: Buffer.from(a.content, 'base64'),
  }));
}

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function validate(message) {
  const { channel, organizationId = null, clientId = null, messageClass = null, recipient = null } = message;
  if (!CHANNELS.includes(channel)) throw new ValidationError(`channel must be one of: ${CHANNELS.join(', ')}`);
  const hasClient = clientId !== null && clientId !== undefined;
  // The same explicit lanes emailTransport enforces: a client message names
  // its organization and class; an operational one has neither client nor class.
  if (hasClient) {
    if (organizationId === null || organizationId === undefined) {
      throw new ValidationError('A client message needs its organization');
    }
    communicationPreferences.assertMessageClass(messageClass);
  } else if (messageClass) {
    throw new ValidationError('An operational message has no messageClass');
  }
  if (channel === 'push') {
    if (!hasClient) throw new ValidationError('A push message is for a client');
    if (!message.payload?.event_type) throw new ValidationError('A push message needs payload.event_type');
  } else if (!recipient) {
    throw new ValidationError(`A ${channel} message needs a recipient`);
  }
  if (channel !== 'email' && channel !== 'push' && !hasClient) {
    throw new ValidationError(`A ${channel} message is for a client`);
  }
  if (channel !== 'push' && !message.bodyText && !message.bodyHtml) {
    throw new ValidationError('A message needs a body');
  }
}

/**
 * Queue one message. Returns { queued: true, id } (also for a dedupe_key seen
 * before, with duplicate: true), or { queued: false, skipped: true, code, id }
 * when the organization or the client's preferences block it now; the
 * skipped row is kept so the block is visible.
 *
 * @param {object} message
 * @param {'email'|'sms'|'whatsapp'|'push'} message.channel
 * @param {number|null} [message.organizationId]
 * @param {number|null} [message.clientId]
 * @param {string|null} [message.messageClass]  required with clientId
 * @param {string} [message.recipient]  email address or E.164 number (not for push)
 * @param {string} [message.subject]
 * @param {string} [message.bodyText]
 * @param {string} [message.bodyHtml]
 * @param {string} [message.emailFunction]  sender identity for email
 * @param {Array}  [message.attachments]  [{ filename, content, contentType }]
 * @param {object} [message.payload]  push: { event_type, title, body, url }; sms: { template_id }
 * @param {string} [message.sourceType]
 * @param {number} [message.sourceId]
 * @param {string} [message.dedupeKey]
 * @param {number} [message.maxAttempts]
 * @param {object} [opts]
 * @param {Function} [opts.exec]  the caller's transaction (conn.execute.bind(conn)); the row
 *   commits with it, and delivery waits for the next sweep
 */
async function enqueue(message, { exec = null, deliverByJob = true } = {}) {
  validate(message);
  const {
    channel, organizationId = null, clientId = null, messageClass = null, recipient = null,
    subject = null, bodyText = null, bodyHtml = null, emailFunction = null, attachments = null,
    payload = null, sourceType = null, sourceId = null, dedupeKey = null, maxAttempts = null,
    sensitive = false,
  } = message;
  const run = exec || ((sql, params) => withTenant(organizationId, () => db.query(sql, params)));

  const owner = await communicationPreferences.getOrganizationDeliveryState(organizationId);
  let status = 'queued';
  let code = null;
  let contactEpoch = 0;
  if (!owner.active) {
    status = 'skipped';
    code = communicationPreferences.BLOCK_CODES.ORGANIZATION_INACTIVE;
  } else if (clientId !== null && clientId !== undefined && channel !== 'push') {
    const preference = await communicationPreferences.evaluateClientCommunication({
      organizationId, clientId, channel, destination: recipient, messageClass,
    });
    if (!preference.allowed) {
      status = 'skipped';
      code = preference.code;
    } else {
      contactEpoch = Number(preference.contactEpoch || 0);
    }
  }

  const fullPayload = { ...(payload || {}) };
  const encoded = channel === 'email' ? encodeAttachments(attachments) : null;
  if (encoded) fullPayload.attachments = encoded;

  const [result] = await run(
    `INSERT IGNORE INTO message_outbox
       (organization_id, organization_epoch, client_id, client_contact_epoch, channel, message_class,
        priority, email_function, recipient, subject, body_text, body_html, payload,
        source_type, source_id, dedupe_key, status, max_attempts, last_error_code, last_error, is_sensitive)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      organizationId, owner.epoch || 0, clientId, contactEpoch, channel, messageClass,
      messageClass ? PRIORITY[messageClass] : OPERATIONAL_PRIORITY,
      emailFunction, recipient, subject ? String(subject).slice(0, 500) : null, bodyText, bodyHtml,
      Object.keys(fullPayload).length ? JSON.stringify(fullPayload) : null,
      sourceType, sourceId, dedupeKey, status, maxAttempts || BACKOFF_MINUTES.length,
      code, code ? 'Blocked at enqueue by the organization state or the client\'s communication preferences.' : null,
      sensitive ? 1 : 0,
    ],
  );

  if (!result.affectedRows) {
    const [rows] = await run('SELECT id, status FROM message_outbox WHERE dedupe_key = ? LIMIT 1', [dedupeKey]);
    return { queued: rows[0]?.status !== 'skipped', duplicate: true, id: rows[0]?.id ?? null };
  }
  const id = result.insertId;
  if (status === 'skipped') {
    noteOutboxMessage(channel, 'skipped');
    return { queued: false, skipped: true, code, id };
  }

  // With Redis, deliver now instead of at the next minute. Not inside the
  // caller's transaction: the job could run before the row commits.
  if (!exec && deliverByJob && process.env.REDIS_URL) {
    const jobQueue = require('./jobQueueService');
    await jobQueue.add('message-outbox', { id, organizationId }, { attempts: 1 }).catch(() => {});
  }
  return { queued: true, id };
}

// ---------------------------------------------------------------------------
// Channel adapters: { outcome: sent|skipped|retry|failed|unknown, ... }
// ---------------------------------------------------------------------------

// Email failures that no retry can fix.
const EMAIL_PERMANENT = new Set(['ORGANIZATION_INACTIVE', 'CLIENT_ATTRIBUTION_REQUIRED', 'UNSAFE_HOST']);

const ADAPTERS = {
  async email(row, payload) {
    const emailTransport = require('./emailTransport');
    const hasClient = row.client_id !== null && row.client_id !== undefined;
    const result = await emailTransport.sendEmail({
      to: row.recipient,
      subject: row.subject || '',
      html: row.body_html || undefined,
      text: row.body_text || undefined,
      attachments: decodeAttachments(payload),
      organizationId: row.organization_id,
      clientId: hasClient ? row.client_id : null,
      messageClass: hasClient ? row.message_class : null,
      operationalRecipient: !hasClient,
      ...(row.email_function && { emailFunction: row.email_function }),
      expectedClientContactEpoch: hasClient ? Number(row.client_contact_epoch || 0) : null,
    });
    if (result.success) return { outcome: 'sent', providerMessageId: result.messageId || null };
    if (result.skipped) return { outcome: 'skipped', code: result.code, error: result.error };
    return { outcome: EMAIL_PERMANENT.has(result.code) ? 'failed' : 'retry', code: result.code, error: result.error };
  },

  async sms(row, payload) {
    const smsTransport = require('./smsTransport');
    const result = await smsTransport.sendSms({
      organizationId: row.organization_id,
      clientId: row.client_id,
      to: row.recipient,
      body: row.body_text || '',
      channel: row.channel,
      templateId: payload.template_id ?? null,
      messageClass: row.message_class,
      expectedClientContactEpoch: Number(row.client_contact_epoch || 0),
    });
    if (result.success) return { outcome: 'sent', providerMessageId: result.messageId || null };
    if (result.skipped) return { outcome: 'skipped', code: result.code, error: result.error };
    // Only a failure that provably never reached the provider is retried.
    if (result.unsent) return { outcome: result.permanent ? 'failed' : 'retry', code: result.code || null, error: result.error };
    return { outcome: 'unknown', code: result.code || null, error: result.error };
  },

  async push(row, payload) {
    const portalPushService = require('./portalPushService');
    const { sent, failed } = await portalPushService.dispatch({
      clientId: row.client_id,
      eventType: payload.event_type,
      payload: { title: payload.title, body: payload.body, url: payload.url },
    });
    if (sent > 0) return { outcome: 'sent' };
    if (failed === 0) return { outcome: 'skipped', code: 'NO_PUSH_SUBSCRIPTION', error: 'The client has no push subscription for this event.' };
    return { outcome: 'retry', code: 'PUSH_DELIVERY_FAILED', error: 'Every push subscription failed.' };
  },
};
ADAPTERS.whatsapp = ADAPTERS.sms;

// ---------------------------------------------------------------------------
// Outcome handlers: producers that keep their own ledger (campaigns)
// ---------------------------------------------------------------------------

const outcomeHandlers = new Map();

/** fn(row, { status, providerMessageId, code, error }) runs after each terminal outcome. */
function onOutcome(sourceType, fn) {
  outcomeHandlers.set(sourceType, fn);
}

let builtInHandlersLoaded = false;

async function notifyOutcome(row, outcome) {
  // Producers' handlers live in one module so they run in whichever process
  // delivers the message, not only where the producer's route is loaded.
  if (!builtInHandlersLoaded) {
    builtInHandlersLoaded = true;
    require('./outboxOutcomeHandlers');
  }
  const handler = row.source_type && outcomeHandlers.get(row.source_type);
  if (!handler) return;
  try {
    await handler(row, outcome);
  } catch (err) {
    logger.warn({ err: err.message, outboxId: row.id, sourceType: row.source_type }, 'Outbox outcome handler failed');
  }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

function backoffMinutes(attempts) {
  return BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1];
}

async function finish(row, result) {
  let status;
  let delay = null;
  if (result.outcome === 'sent') status = 'sent';
  else if (result.outcome === 'skipped') status = 'skipped';
  else if (result.outcome === 'unknown') status = 'outcome_unknown';
  else if (result.outcome === 'retry' && row.attempts < row.max_attempts) {
    status = 'queued';
    delay = backoffMinutes(row.attempts);
  } else status = 'failed';

  const [update] = await db.query(
    `UPDATE message_outbox
        SET status = ?, sent_at = ${status === 'sent' ? 'NOW()' : 'sent_at'},
            next_attempt_at = ${delay !== null ? `NOW() + INTERVAL ${delay} MINUTE` : 'next_attempt_at'},
            provider_message_id = ?, last_error_code = ?, last_error = ?, claimed_at = NULL
      WHERE id = ? AND status = 'sending'`,
    [
      status, result.providerMessageId || null,
      status === 'sent' ? null : (result.code || null),
      status === 'sent' ? null : (result.error ? String(result.error).slice(0, 1000) : null),
      row.id,
    ],
  );
  if (update.affectedRows !== 1) return { status: 'lost' };
  if (status !== 'queued' && Number(row.is_sensitive)) await clearSensitive(row.id);
  noteOutboxMessage(row.channel, status === 'queued' ? 'retried' : status);
  if (status !== 'queued') {
    await notifyOutcome(row, { status, providerMessageId: result.providerMessageId || null, code: result.code || null, error: result.error || null });
  }
  if (status === 'failed' || status === 'outcome_unknown') {
    logger.warn({ outboxId: row.id, channel: row.channel, status, code: result.code }, 'Outbox message needs attention');
  }
  return { status };
}

/** A secret-bearing message keeps no body once it is final. */
async function clearSensitive(id) {
  await db.query(
    'UPDATE message_outbox SET body_text = NULL, body_html = NULL, payload = NULL WHERE id = ? AND is_sensitive = 1',
    [id],
  );
}

/** Claim and deliver one queued row of the current database. */
async function deliverRow(row) {
  const [claim] = await db.query(
    `UPDATE message_outbox SET status = 'claimed', claimed_at = NOW(), attempts = attempts + 1
      WHERE id = ? AND status = 'queued'`,
    [row.id],
  );
  if (claim.affectedRows !== 1) return { status: 'lost' };
  const claimed = { ...row, attempts: Number(row.attempts || 0) + 1 };

  const owner = await communicationPreferences.getOrganizationDeliveryState(row.organization_id);
  if (!owner.active || Number(owner.epoch) !== Number(row.organization_epoch || 0)) {
    await db.query("UPDATE message_outbox SET status = 'sending' WHERE id = ? AND status = 'claimed'", [row.id]);
    return finish(claimed, {
      outcome: 'skipped',
      code: communicationPreferences.BLOCK_CODES.ORGANIZATION_INACTIVE,
      error: 'Organization delivery authorization changed; message skipped.',
    });
  }

  // From here a crash is ambiguous: the provider may have the message.
  const [sending] = await db.query(
    "UPDATE message_outbox SET status = 'sending' WHERE id = ? AND status = 'claimed'",
    [row.id],
  );
  if (sending.affectedRows !== 1) return { status: 'lost' };

  let result;
  try {
    result = await ADAPTERS[row.channel](claimed, parsePayload(row.payload));
  } catch (err) {
    // An adapter that throws may have reached the provider first.
    result = { outcome: 'unknown', code: err.code || 'DELIVERY_FAILED', error: err.message };
  }
  return finish(claimed, result);
}

async function recoverStale(scope, params) {
  await db.query(
    `UPDATE message_outbox SET status = 'queued', claimed_at = NULL
      WHERE status = 'claimed' AND claimed_at < NOW() - INTERVAL ${CLAIM_STALE_MINUTES} MINUTE${scope}`,
    params,
  );
  const [unknown] = await db.query(
    `UPDATE message_outbox
        SET status = 'outcome_unknown', last_error_code = 'DELIVERY_OUTCOME_UNKNOWN',
            last_error = 'The worker stopped during the provider call; the message may or may not have been sent.'
      WHERE status = 'sending' AND claimed_at < NOW() - INTERVAL ${SENDING_STALE_MINUTES} MINUTE${scope}`,
    params,
  );
  if (unknown?.affectedRows) logger.warn({ count: unknown.affectedRows }, 'Outbox messages left mid-delivery marked outcome_unknown');
}

async function refreshBacklog(scope, params) {
  const [rows] = await db.query(
    `SELECT status, channel, COUNT(*) AS n FROM message_outbox
      WHERE status IN ('queued', 'claimed', 'sending', 'failed', 'outcome_unknown')${scope}
      GROUP BY status, channel`,
    params,
  );
  const [[oldest]] = await db.query(
    `SELECT TIMESTAMPDIFF(SECOND, MIN(created_at), NOW()) AS age FROM message_outbox
      WHERE status = 'queued'${scope}`,
    params,
  );
  return { rows: rows.map(r => ({ status: r.status, channel: r.channel, n: Number(r.n) })), oldest: Number(oldest?.age || 0) };
}

/** One pass over the current database. */
async function processCurrentQueue({ organizationId = null, excludeOrganizationIds = [] } = {}) {
  const excluded = [...new Set(excludeOrganizationIds.map(Number).filter(Number.isSafeInteger))];
  const params = [];
  let scope = '';
  if (organizationId !== null && organizationId !== undefined) {
    scope = ' AND organization_id = ?';
    params.push(Number(organizationId));
  } else if (excluded.length) {
    scope = ` AND (organization_id IS NULL OR organization_id NOT IN (${excluded.map(() => '?').join(',')}))`;
    params.push(...excluded);
  }
  await recoverStale(scope, params);

  const [due] = await db.query(
    `SELECT * FROM message_outbox
      WHERE status = 'queued' AND next_attempt_at <= NOW()${scope}
      ORDER BY priority ASC, next_attempt_at ASC, id ASC
      LIMIT ${BATCH_SIZE}`,
    params,
  );
  const [recent] = await db.query(
    `SELECT organization_id, channel, COUNT(*) AS n FROM message_outbox
      WHERE status = 'sent' AND sent_at >= NOW() - INTERVAL 1 MINUTE${scope}
      GROUP BY organization_id, channel`,
    params,
  );
  const sentThisMinute = new Map(recent.map(r => [`${r.organization_id}|${r.channel}`, Number(r.n)]));

  const totals = { sent: 0, skipped: 0, retried: 0, failed: 0, outcome_unknown: 0, deferred: 0, total: due.length };
  for (const row of due) {
    const key = `${row.organization_id}|${row.channel}`;
    if ((sentThisMinute.get(key) || 0) >= rateLimit(row.channel)) {
      await db.query(
        "UPDATE message_outbox SET next_attempt_at = NOW() + INTERVAL 1 MINUTE WHERE id = ? AND status = 'queued'",
        [row.id],
      );
      noteOutboxMessage(row.channel, 'deferred');
      totals.deferred++;
      continue;
    }
    try {
      const { status } = await deliverRow(row);
      if (status === 'sent') {
        sentThisMinute.set(key, (sentThisMinute.get(key) || 0) + 1);
        totals.sent++;
      } else if (status === 'queued') totals.retried++;
      else if (status in totals) totals[status]++;
    } catch (err) {
      logger.warn({ err: err.message, outboxId: row.id }, 'Outbox delivery pass failed for a message');
    }
  }
  return { totals, backlog: await refreshBacklog(scope, params) };
}

function merge(target, pass) {
  for (const k of Object.keys(target.totals)) target.totals[k] += Number(pass.totals[k] || 0);
  target.backlog.push(...pass.backlog.rows);
  target.oldest = Math.max(target.oldest, pass.backlog.oldest);
}

/**
 * Deliver due messages: the primary database, then each isolated tenant
 * database, or one organization's scope when organizationId is given.
 */
async function processQueue(organizationId = null) {
  const total = {
    totals: { sent: 0, skipped: 0, retried: 0, failed: 0, outcome_unknown: 0, deferred: 0, total: 0 },
    backlog: [],
    oldest: 0,
  };
  if (organizationId !== null && organizationId !== undefined) {
    merge(total, await withTenant(organizationId, () => processCurrentQueue({ organizationId: Number(organizationId) })));
  } else if (typeof db.withPrimaryContext !== 'function' || typeof db.withTenantContext !== 'function') {
    merge(total, await processCurrentQueue());
  } else {
    const [isolated] = await db.withPrimaryContext(() => db.query(
      `SELECT organization_id FROM organization_database_configs
        WHERE isolation_mode = 'isolated' ORDER BY organization_id`,
    ));
    const isolatedIds = isolated.map(r => Number(r.organization_id)).filter(Number.isSafeInteger);
    merge(total, await db.withPrimaryContext(() => processCurrentQueue({ excludeOrganizationIds: isolatedIds })));
    for (const orgId of isolatedIds) {
      try {
        merge(total, await db.withTenantContext(orgId, () => processCurrentQueue({ organizationId: orgId })));
      } catch (err) {
        logger.warn({ err: err.message, organizationId: orgId }, 'Outbox delivery pass failed for an isolated organization');
      }
    }
  }
  if (organizationId === null || organizationId === undefined) {
    const byKey = new Map();
    for (const r of total.backlog) {
      const key = `${r.status}|${r.channel}`;
      byKey.set(key, { ...r, n: (byKey.get(key)?.n || 0) + r.n });
    }
    noteOutboxBacklog([...byKey.values()], total.oldest);
  }
  return total.totals;
}

/**
 * enqueue() for email, with emailTransport.sendEmail's option names, so a
 * sender moves to the outbox by changing the function it calls.
 * @param {object} opts  to, subject, html, text, attachments, organizationId, clientId,
 *   messageClass, emailFunction, operationalRecipient, sensitive, dedupeKey, sourceType,
 *   sourceId, maxAttempts
 */
function emailMessage({
  to, subject = null, html = null, text = null, attachments = null, organizationId = null, clientId = null,
  messageClass = null, emailFunction = null, operationalRecipient = false, sensitive = false,
  dedupeKey = null, sourceType = null, sourceId = null, maxAttempts = null,
}) {
  const hasClient = clientId !== null && clientId !== undefined;
  if (!hasClient && !operationalRecipient) {
    throw new ValidationError('An email without a client must be marked operationalRecipient');
  }
  return {
    channel: 'email', organizationId, clientId: hasClient ? clientId : null, messageClass: hasClient ? messageClass : null,
    recipient: to, subject, bodyText: text, bodyHtml: html, attachments, emailFunction, sensitive,
    dedupeKey, sourceType, sourceId, maxAttempts,
  };
}

function queueEmail(opts, enqueueOpts) {
  return enqueue(emailMessage(opts), enqueueOpts);
}

function sendEmailNow(opts) {
  return sendNow(emailMessage(opts));
}

/**
 * Queue a message and deliver it in this request, for a caller that must
 * tell a person what happened (a staff "send now", a legal notice). The row
 * follows every outbox rule: a retryable failure stays queued and the sweep
 * retries it; pass maxAttempts: 1 when the caller falls back to another
 * channel instead. Not rate limited: it is one message.
 *
 * @returns {{ id, status: 'sent'|'skipped'|'queued'|'failed'|'outcome_unknown', providerMessageId?, code?, error? }}
 */
async function sendNow(message) {
  const queued = await enqueue(message, { deliverByJob: false });
  if (!queued.queued) {
    return { id: queued.id, status: 'skipped', code: queued.code || null, error: 'Blocked by the organization state or the client\'s communication preferences.' };
  }
  return withTenant(message.organizationId ?? null, async () => {
    const [rows] = await db.query('SELECT * FROM message_outbox WHERE id = ?', [queued.id]);
    const row = rows[0];
    if (!row) return { id: queued.id, status: 'queued' };
    if (row.status !== 'queued') return { id: row.id, status: row.status, providerMessageId: row.provider_message_id || null };
    await deliverRow(row);
    const [after] = await db.query(
      'SELECT status, provider_message_id, last_error_code, last_error FROM message_outbox WHERE id = ?',
      [queued.id],
    );
    const a = after[0] || {};
    return {
      id: queued.id,
      status: a.status || 'queued',
      providerMessageId: a.provider_message_id || null,
      code: a.last_error_code || null,
      error: a.last_error || null,
    };
  });
}

/** Deliver one row now (the 'message-outbox' job). */
async function deliverNow(id, organizationId = null) {
  return withTenant(organizationId, async () => {
    const [rows] = await db.query(
      "SELECT * FROM message_outbox WHERE id = ? AND status = 'queued' AND next_attempt_at <= NOW()",
      [id],
    );
    if (!rows[0]) return { status: 'not_due' };
    return deliverRow(rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Staff view: /message-outbox
// ---------------------------------------------------------------------------

const LIST_COLUMNS = `id, organization_id, client_id, channel, message_class, recipient, subject, is_sensitive,
  source_type, source_id, status, attempts, max_attempts, next_attempt_at, sent_at,
  provider_message_id, last_error_code, last_error, created_at, updated_at`;

async function list(orgId, { status = null, channel = null, clientId = null, page = 1, limit = 50 } = {}) {
  const where = ['organization_id = ?'];
  const params = [orgId];
  if (status) { where.push('status = ?'); params.push(status); }
  if (channel) { where.push('channel = ?'); params.push(channel); }
  if (clientId) { where.push('client_id = ?'); params.push(Number(clientId)); }
  const safeLimit = Math.min(Math.max(1, Number.parseInt(limit, 10) || 50), 200);
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const [rows] = await db.query(
    `SELECT ${LIST_COLUMNS} FROM message_outbox WHERE ${where.join(' AND ')}
      ORDER BY id DESC LIMIT ${safeLimit} OFFSET ${(safePage - 1) * safeLimit}`,
    params,
  );
  const [[count]] = await db.query(`SELECT COUNT(*) AS total FROM message_outbox WHERE ${where.join(' AND ')}`, params);
  const total = Number(count?.total || 0);
  return { data: rows, meta: { page: safePage, limit: safeLimit, total, totalPages: Math.max(1, Math.ceil(total / safeLimit)) } };
}

async function summary(orgId) {
  const [rows] = await db.query(
    `SELECT status, channel, COUNT(*) AS n FROM message_outbox
      WHERE organization_id = ? AND (status NOT IN ('sent', 'skipped', 'cancelled') OR created_at >= NOW() - INTERVAL 1 DAY)
      GROUP BY status, channel`,
    [orgId],
  );
  return rows.map(r => ({ status: r.status, channel: r.channel, count: Number(r.n) }));
}

async function get(id, orgId) {
  const [rows] = await db.query(
    `SELECT ${LIST_COLUMNS}, body_text, body_html, payload FROM message_outbox WHERE id = ? AND organization_id = ?`,
    [id, orgId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('Message');
  if (Number(row.is_sensitive)) {
    // A reset link or code must not be readable by staff.
    return { ...row, body_text: null, body_html: null, payload: {}, is_sensitive: 1 };
  }
  // Attachment bytes stay out of the API: names and sizes only.
  const payload = parsePayload(row.payload);
  if (Array.isArray(payload.attachments)) {
    payload.attachments = payload.attachments.map(a => ({
      filename: a.filename, contentType: a.contentType, bytes: Buffer.byteLength(a.content || '', 'base64'),
    }));
  }
  return { ...row, payload };
}

/**
 * Put a failed, undelivered or cancelled message back in the queue. An
 * outcome_unknown message may already have been delivered, so retrying it
 * needs confirmPossibleDuplicate.
 */
async function retry(id, orgId, { confirmPossibleDuplicate = false } = {}) {
  const row = await get(id, orgId);
  if (!RETRYABLE_FROM.includes(row.status)) {
    throw new AppError(`A ${row.status} message cannot be retried.`, 409, 'OUTBOX_NOT_RETRYABLE');
  }
  if (Number(row.is_sensitive)) {
    throw new AppError('This message carried a secret that is no longer kept; the recipient requests a new one.', 409, 'OUTBOX_NOT_RETRYABLE');
  }
  if (row.status === 'outcome_unknown' && !confirmPossibleDuplicate) {
    throw new AppError(
      'This message may already have been delivered. Confirm a possible duplicate to send it again.',
      409, 'OUTBOX_POSSIBLE_DUPLICATE',
    );
  }
  const [update] = await db.query(
    `UPDATE message_outbox
        SET status = 'queued', attempts = 0, next_attempt_at = NOW(), claimed_at = NULL,
            last_error_code = NULL, last_error = NULL
      WHERE id = ? AND organization_id = ? AND status = ?`,
    [id, orgId, row.status],
  );
  if (update.affectedRows !== 1) throw new AppError('The message changed; reload it.', 409, 'OUTBOX_CHANGED');
  return get(id, orgId);
}

async function cancel(id, orgId) {
  const row = await get(id, orgId);
  if (!CANCELLABLE_FROM.includes(row.status)) {
    throw new AppError(`A ${row.status} message cannot be cancelled.`, 409, 'OUTBOX_NOT_CANCELLABLE');
  }
  const [update] = await db.query(
    "UPDATE message_outbox SET status = 'cancelled', claimed_at = NULL WHERE id = ? AND organization_id = ? AND status = ?",
    [id, orgId, row.status],
  );
  if (update.affectedRows !== 1) throw new AppError('The message changed; reload it.', 409, 'OUTBOX_CHANGED');
  await clearSensitive(id);
  const cancelled = await get(id, orgId);
  await notifyOutcome(cancelled, { status: 'cancelled', providerMessageId: null, code: 'CANCELLED', error: 'Cancelled by staff.' });
  return cancelled;
}

/**
 * Cancel the still-queued messages a producer sent for these sources (a
 * cancelled campaign). Messages already being delivered are left alone.
 * @returns {Promise<number>} how many were cancelled
 */
async function cancelQueuedBySource(orgId, sourceType, sourceIds) {
  const ids = [...new Set((sourceIds || []).map(Number).filter(Number.isSafeInteger))];
  if (ids.length === 0) return 0;
  return withTenant(orgId, async () => {
    const [rows] = await db.query(
      `SELECT * FROM message_outbox
        WHERE organization_id = ? AND source_type = ? AND status = 'queued'
          AND source_id IN (${ids.map(() => '?').join(',')})`,
      [orgId, sourceType, ...ids],
    );
    let cancelled = 0;
    for (const row of rows) {
      const [update] = await db.query(
        "UPDATE message_outbox SET status = 'cancelled' WHERE id = ? AND status = 'queued'",
        [row.id],
      );
      if (update.affectedRows !== 1) continue;
      cancelled++;
      await clearSensitive(row.id);
      await notifyOutcome(row, { status: 'cancelled', providerMessageId: null, code: 'CANCELLED', error: 'The producer cancelled it.' });
    }
    return cancelled;
  });
}

module.exports = {
  CHANNELS,
  BACKOFF_MINUTES,
  enqueue,
  queueEmail,
  sendEmailNow,
  sendNow,
  processQueue,
  deliverNow,
  onOutcome,
  list,
  summary,
  get,
  retry,
  cancel,
  cancelQueuedBySource,
  _adapters: ADAPTERS,
};
