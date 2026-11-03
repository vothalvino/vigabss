'use strict';
// =============================================================================
// A stand-in for src/services/messageOutbox for tests of message producers
// =============================================================================
// Producers queue messages in the outbox (ASY-33); their tests still want to
// see what each message says. jest.mock the outbox with this module and every
// queued or sent message is handed straight to the (mocked) transport, with
// the outbox's answer shape. Delivery rules (retries, claims, rate limits)
// are tested in tests/messageOutbox.test.js.
//
//   jest.mock('../src/services/messageOutbox', () => require('./helpers/outboxPassThrough'));
// =============================================================================

const transports = () => ({
  email: require('../../src/services/emailTransport'),
  sms: require('../../src/services/smsTransport'),
  push: require('../../src/services/portalPushService'),
});

function emailOptions(m) {
  return {
    to: m.recipient, subject: m.subject, html: m.bodyHtml || undefined, text: m.bodyText || undefined,
    attachments: m.attachments || undefined, organizationId: m.organizationId ?? null,
    clientId: m.clientId ?? null, messageClass: m.messageClass ?? null,
    ...(m.emailFunction && { emailFunction: m.emailFunction }),
    ...((m.clientId === null || m.clientId === undefined) && { operationalRecipient: true }),
  };
}

function toMessage(opts) {
  return {
    channel: 'email', organizationId: opts.organizationId ?? null, clientId: opts.clientId ?? null,
    messageClass: opts.messageClass ?? null, recipient: opts.to, subject: opts.subject,
    bodyText: opts.text, bodyHtml: opts.html, attachments: opts.attachments, emailFunction: opts.emailFunction,
  };
}

async function deliver(m) {
  const t = transports();
  if (m.channel === 'email') {
    const r = await t.email.sendEmail(emailOptions(m));
    return { status: r?.success ? 'sent' : (r?.skipped ? 'skipped' : 'failed'), providerMessageId: r?.messageId || null, code: r?.code || null, error: r?.error || null };
  }
  if (m.channel === 'push') {
    const r = await t.push.dispatch({ clientId: m.clientId, eventType: m.payload?.event_type, payload: { title: m.payload?.title, body: m.payload?.body, url: m.payload?.url } });
    return { status: r?.sent > 0 ? 'sent' : (r?.failed ? 'failed' : 'skipped') };
  }
  const r = await t.sms.sendSms({
    organizationId: m.organizationId, clientId: m.clientId, to: m.recipient, body: m.bodyText,
    channel: m.channel, templateId: m.payload?.template_id ?? null, messageClass: m.messageClass,
  });
  return { status: r?.success ? 'sent' : (r?.skipped ? 'skipped' : 'failed'), providerMessageId: r?.messageId || null, code: r?.code || null, error: r?.error || null };
}

// Plain functions, not jest.fn: suites that call jest.resetAllMocks() must not
// strip the stand-in of its behaviour.
let nextId = 1;
async function enqueue(m) {
  const r = await deliver(m);
  return r.status === 'skipped' ? { queued: false, skipped: true, code: r.code, id: nextId++ } : { queued: true, id: nextId++ };
}
async function sendNow(m) {
  return { id: nextId++, ...(await deliver(m)) };
}

module.exports = {
  CHANNELS: ['email', 'sms', 'whatsapp', 'push'],
  enqueue,
  sendNow,
  queueEmail: opts => enqueue(toMessage(opts)),
  sendEmailNow: opts => sendNow(toMessage(opts)),
  onOutcome: () => {},
  processQueue: async () => ({}),
};
