'use strict';
// =============================================================================
// ASY-33 — one durable outbox for email, SMS, WhatsApp and push
// =============================================================================
// Email was sent inline and never retried, push had no queue, SMS had a queue
// without retries. messageOutbox is the one queue; these tests run its state
// machine against an in-memory message_outbox table.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('../src/services/clientCommunicationPreferenceService', () => {
  const actual = jest.requireActual('../src/services/clientCommunicationPreferenceService');
  return {
    ...actual,
    getOrganizationDeliveryState: jest.fn(async () => ({ active: true, epoch: 3 })),
    evaluateClientCommunication: jest.fn(async () => ({ allowed: true, contactEpoch: 7 })),
  };
});
jest.mock('../src/services/emailTransport', () => ({ sendEmail: jest.fn() }));
jest.mock('../src/services/smsTransport', () => ({ sendSms: jest.fn() }));
jest.mock('../src/services/portalPushService', () => ({ dispatch: jest.fn() }));

const db = require('../src/config/database');
const prefs = require('../src/services/clientCommunicationPreferenceService');
const emailTransport = require('../src/services/emailTransport');
const smsTransport = require('../src/services/smsTransport');
const portalPushService = require('../src/services/portalPushService');
const outbox = require('../src/services/messageOutbox');

// ---------------------------------------------------------------------------
// In-memory message_outbox: answers exactly the statements messageOutbox runs.
// ---------------------------------------------------------------------------
let rows;
let nextId;
const COLUMNS = ['organization_id', 'organization_epoch', 'client_id', 'client_contact_epoch', 'channel', 'message_class',
  'priority', 'email_function', 'recipient', 'subject', 'body_text', 'body_html', 'payload',
  'source_type', 'source_id', 'dedupe_key', 'status', 'max_attempts', 'last_error_code', 'last_error', 'sensitive'];

function fakeQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.startsWith('INSERT IGNORE INTO message_outbox')) {
    const row = Object.fromEntries(COLUMNS.map((c, i) => [c, params[i]]));
    if (row.dedupe_key && rows.some(r => r.dedupe_key === row.dedupe_key)) return [{ affectedRows: 0 }];
    Object.assign(row, { id: nextId++, attempts: 0, next_attempt_at: 0, claimed_at: null, sent_at: null, provider_message_id: null });
    rows.push(row);
    return [{ affectedRows: 1, insertId: row.id }];
  }
  if (s.startsWith('SELECT id, status FROM message_outbox WHERE dedupe_key')) {
    return [rows.filter(r => r.dedupe_key === params[0]).map(r => ({ id: r.id, status: r.status }))];
  }
  if (s.startsWith("UPDATE message_outbox SET status = 'claimed'")) {
    const r = rows.find(x => x.id === params[0] && x.status === 'queued');
    if (!r) return [{ affectedRows: 0 }];
    Object.assign(r, { status: 'claimed', claimed_at: 'now', attempts: r.attempts + 1 });
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("UPDATE message_outbox SET status = 'sending'")) {
    const r = rows.find(x => x.id === params[0] && x.status === 'claimed');
    if (!r) return [{ affectedRows: 0 }];
    r.status = 'sending';
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith('UPDATE message_outbox SET status = ?, sent_at')) {
    const [status, providerId, code, error, id] = params;
    const r = rows.find(x => x.id === id && x.status === 'sending');
    if (!r) return [{ affectedRows: 0 }];
    const delay = /NOW\(\) \+ INTERVAL (\d+) MINUTE/.exec(s);
    Object.assign(r, { status, provider_message_id: providerId, last_error_code: code, last_error: error, claimed_at: null });
    if (status === 'sent') r.sent_at = 'now';
    if (delay) r.next_attempt_at = Number(delay[1]);
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("UPDATE message_outbox SET status = 'queued', claimed_at = NULL WHERE status = 'claimed'")) return [{ affectedRows: 0 }];
  if (s.startsWith("UPDATE message_outbox SET status = 'outcome_unknown'")) return [{ affectedRows: 0 }];
  if (s.startsWith("SELECT * FROM message_outbox WHERE status = 'queued' AND next_attempt_at <= NOW()")) {
    return [rows.filter(r => r.status === 'queued' && r.next_attempt_at === 0)
      .sort((a, b) => a.priority - b.priority || a.id - b.id).map(r => ({ ...r }))];
  }
  if (s.startsWith("SELECT organization_id, channel, COUNT(*) AS n FROM message_outbox WHERE status = 'sent'")) {
    const counts = new Map();
    for (const r of rows.filter(x => x.status === 'sent')) {
      const k = `${r.organization_id}|${r.channel}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [[...counts].map(([k, n]) => ({ organization_id: Number(k.split('|')[0]), channel: k.split('|')[1], n }))];
  }
  if (s.startsWith('UPDATE message_outbox SET next_attempt_at = NOW() + INTERVAL 1 MINUTE')) {
    const r = rows.find(x => x.id === params[0] && x.status === 'queued');
    if (r) r.next_attempt_at = 1;
    return [{ affectedRows: r ? 1 : 0 }];
  }
  if (s.startsWith('SELECT status, channel, COUNT(*) AS n FROM message_outbox WHERE status IN')) return [[]];
  if (s.startsWith('SELECT TIMESTAMPDIFF')) return [[{ age: 0 }]];
  if (/^SELECT .* FROM message_outbox WHERE id = \? AND organization_id = \?/.test(s)) {
    return [rows.filter(r => r.id === params[0] && r.organization_id === params[1]).map(r => ({ ...r }))];
  }
  if (s.startsWith("UPDATE message_outbox SET status = 'queued', attempts = 0")) {
    const [id, org, from] = params;
    const r = rows.find(x => x.id === id && x.organization_id === org && x.status === from);
    if (!r) return [{ affectedRows: 0 }];
    Object.assign(r, { status: 'queued', attempts: 0, next_attempt_at: 0, last_error_code: null, last_error: null });
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("UPDATE message_outbox SET status = 'cancelled'")) {
    const [id, org, from] = params;
    const r = rows.find(x => x.id === id && x.organization_id === org && x.status === from);
    if (!r) return [{ affectedRows: 0 }];
    r.status = 'cancelled';
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith('UPDATE service_modification_notices')) return [{ affectedRows: 1 }];
  if (s.startsWith('UPDATE message_outbox SET body_text = NULL, body_html = NULL, payload = NULL')) {
    const r = rows.find(x => x.id === params[0] && x.sensitive === 1);
    if (r) Object.assign(r, { body_text: null, body_html: null, payload: null });
    return [{ affectedRows: r ? 1 : 0 }];
  }
  throw new Error(`Unexpected SQL in the fake: ${s.slice(0, 120)}`);
}

const clientEmail = (over = {}) => ({
  channel: 'email', organizationId: 5, clientId: 9, messageClass: 'transactional',
  recipient: 'ana@example.com', subject: 'Your invoice', bodyText: 'Hello', ...over,
});
const row = id => rows.find(r => r.id === id);

beforeEach(() => {
  jest.clearAllMocks();
  rows = [];
  nextId = 1;
  db.query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
  delete process.env.REDIS_URL;
});

describe('enqueue', () => {
  test('a client message is queued with the organization and contact epochs it was checked against', async () => {
    const res = await outbox.enqueue(clientEmail());

    expect(res).toEqual({ queued: true, id: 1 });
    expect(row(1)).toMatchObject({ status: 'queued', organization_epoch: 3, client_contact_epoch: 7, priority: 3 });
    expect(prefs.evaluateClientCommunication).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 5, clientId: 9, channel: 'email', destination: 'ana@example.com', messageClass: 'transactional',
    }));
  });

  test('a message the client\'s preferences block is kept as skipped, never queued', async () => {
    prefs.evaluateClientCommunication.mockResolvedValueOnce({ allowed: false, code: 'CLIENT_COMMUNICATION_OPTED_OUT' });

    const res = await outbox.enqueue(clientEmail({ messageClass: 'marketing' }));

    expect(res).toMatchObject({ queued: false, skipped: true, code: 'CLIENT_COMMUNICATION_OPTED_OUT' });
    expect(row(1).status).toBe('skipped');
  });

  test('a dedupe key enqueues once', async () => {
    await outbox.enqueue(clientEmail({ dedupeKey: 'invoice:77:email' }));
    const again = await outbox.enqueue(clientEmail({ dedupeKey: 'invoice:77:email' }));

    expect(again).toEqual({ queued: true, duplicate: true, id: 1 });
    expect(rows).toHaveLength(1);
  });

  test.each([
    ['a client message without a class', clientEmail({ messageClass: null })],
    ['an operational message with a class', { channel: 'email', recipient: 'noc@isp.mx', bodyText: 'x', messageClass: 'transactional' }],
    ['an SMS without a client', { channel: 'sms', organizationId: 5, recipient: '+5215555555555', bodyText: 'x' }],
    ['a push without an event', { channel: 'push', organizationId: 5, clientId: 9, messageClass: 'transactional', payload: {} }],
    ['a message without a body', clientEmail({ bodyText: null })],
  ])('%s is refused', async (_label, message) => {
    await expect(outbox.enqueue(message)).rejects.toMatchObject({ statusCode: 422 });
    expect(rows).toHaveLength(0);
  });
});

describe('delivery', () => {
  test('a queued email is claimed, sent and recorded with the provider id', async () => {
    emailTransport.sendEmail.mockResolvedValue({ success: true, messageId: '<m1@isp>' });
    await outbox.enqueue(clientEmail());

    const totals = await outbox.processQueue();

    expect(totals).toMatchObject({ sent: 1, total: 1 });
    expect(row(1)).toMatchObject({ status: 'sent', attempts: 1, provider_message_id: '<m1@isp>' });
    expect(emailTransport.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'ana@example.com', clientId: 9, messageClass: 'transactional', expectedClientContactEpoch: 7,
    }));
  });

  test('a failed email is retried with backoff, then gives up after max_attempts', async () => {
    emailTransport.sendEmail.mockResolvedValue({ success: false, code: 'EMAIL_DELIVERY_TIMEOUT', error: 'timed out' });
    await outbox.enqueue(clientEmail({ maxAttempts: 2 }));

    await outbox.processQueue();
    expect(row(1)).toMatchObject({ status: 'queued', attempts: 1, next_attempt_at: outbox.BACKOFF_MINUTES[0], last_error_code: 'EMAIL_DELIVERY_TIMEOUT' });

    row(1).next_attempt_at = 0; // the backoff has passed
    await outbox.processQueue();
    expect(row(1)).toMatchObject({ status: 'failed', attempts: 2 });
  });

  test('an email the transport refuses for good is not retried', async () => {
    emailTransport.sendEmail.mockResolvedValue({ success: false, code: 'UNSAFE_HOST', error: 'not permitted' });
    await outbox.enqueue(clientEmail());

    await outbox.processQueue();

    expect(row(1)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  test('a consent block found by the transport is skipped', async () => {
    emailTransport.sendEmail.mockResolvedValue({ success: false, skipped: true, code: 'CLIENT_COMMUNICATION_OPTED_OUT' });
    await outbox.enqueue(clientEmail());

    await outbox.processQueue();

    expect(row(1)).toMatchObject({ status: 'skipped', last_error_code: 'CLIENT_COMMUNICATION_OPTED_OUT' });
  });

  test('an organization whose delivery state changed since enqueue skips without calling the provider', async () => {
    await outbox.enqueue(clientEmail());
    prefs.getOrganizationDeliveryState.mockResolvedValueOnce({ active: true, epoch: 4 });

    await outbox.processQueue();

    expect(row(1).status).toBe('skipped');
    expect(emailTransport.sendEmail).not.toHaveBeenCalled();
  });

  describe('SMS and WhatsApp are retried only when provably unsent', () => {
    const sms = { channel: 'sms', organizationId: 5, clientId: 9, messageClass: 'transactional', recipient: '+5215555555555', bodyText: 'Pago recibido' };

    test.each([
      ['the provider answered with a 503', { success: false, unsent: true, code: '503' }, 'queued'],
      ['the provider refused the number (400)', { success: false, unsent: true, permanent: true, code: '21211' }, 'failed'],
      ['the request timed out', { success: false, code: null, error: 'timed out' }, 'outcome_unknown'],
    ])('%s', async (_label, result, status) => {
      smsTransport.sendSms.mockResolvedValue(result);
      await outbox.enqueue(sms);

      await outbox.processQueue();

      expect(row(1).status).toBe(status);
    });
  });

  test('a push with no subscription is skipped; one whose subscriptions all fail is retried', async () => {
    const push = { channel: 'push', organizationId: 5, clientId: 9, messageClass: 'transactional', payload: { event_type: 'invoice_created', title: 'Factura' } };
    portalPushService.dispatch.mockResolvedValueOnce({ sent: 0, failed: 0 }).mockResolvedValueOnce({ sent: 0, failed: 2 });
    await outbox.enqueue(push);
    await outbox.enqueue(push);

    await outbox.processQueue();

    expect(row(1).status).toBe('skipped');
    expect(row(2).status).toBe('queued');
    expect(portalPushService.dispatch).toHaveBeenCalledWith({ clientId: 9, eventType: 'invoice_created', payload: { title: 'Factura', body: undefined, url: undefined } });
  });

  test('an organization over its per-minute budget waits for the next minute', async () => {
    process.env.OUTBOX_RATE_EMAIL_PER_MINUTE = '1';
    emailTransport.sendEmail.mockResolvedValue({ success: true, messageId: 'x' });
    await outbox.enqueue(clientEmail());
    await outbox.enqueue(clientEmail());
    await outbox.enqueue(clientEmail({ organizationId: 6 }));

    const totals = await outbox.processQueue();
    delete process.env.OUTBOX_RATE_EMAIL_PER_MINUTE;

    expect(totals).toMatchObject({ sent: 2, deferred: 1 });
    expect(row(2)).toMatchObject({ status: 'queued', next_attempt_at: 1, attempts: 0 });
  });

  test('security messages go before marketing', async () => {
    emailTransport.sendEmail.mockResolvedValue({ success: true });
    await outbox.enqueue(clientEmail({ messageClass: 'marketing' }));
    await outbox.enqueue(clientEmail({ messageClass: 'security' }));

    await outbox.processQueue();

    expect(emailTransport.sendEmail.mock.calls.map(([m]) => m.messageClass)).toEqual(['security', 'marketing']);
  });

  test('a producer\'s outcome handler hears each terminal outcome', async () => {
    const handler = jest.fn();
    outbox.onOutcome('campaign_message', handler);
    emailTransport.sendEmail.mockResolvedValue({ success: true, messageId: 'p-1' });
    await outbox.enqueue(clientEmail({ sourceType: 'campaign_message', sourceId: 44, messageClass: 'marketing' }));

    await outbox.processQueue();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 1, source_id: 44 }), expect.objectContaining({ status: 'sent', providerMessageId: 'p-1' }));
  });
});

test('a service-modification notice delivered on a later retry is marked sent then', async () => {
  emailTransport.sendEmail
    .mockResolvedValueOnce({ success: false, code: 'EMAIL_DELIVERY_FAILED' })
    .mockResolvedValueOnce({ success: true, messageId: '<n9@isp>' });
  await outbox.enqueue(clientEmail({ sourceType: 'service_modification_notice', sourceId: 9 }));
  const marks = () => db.query.mock.calls.filter(([sql]) => /UPDATE service_modification_notices/.test(sql));

  await outbox.processQueue();
  expect(marks()).toHaveLength(0);

  row(1).next_attempt_at = 0;
  await outbox.processQueue();
  expect(marks()).toHaveLength(1);
  expect(marks()[0][1]).toEqual(['Sent by email (<n9@isp>)', 9, 5]);
});

describe('a message that carries a secret', () => {
  const reset = { channel: 'email', operationalRecipient: true, to: 'staff@isp.mx', subject: 'Reset', html: '<a href="https://x/reset?token=s3cret">reset</a>', sensitive: true };

  test('keeps no body once delivered, and the API never shows it', async () => {
    emailTransport.sendEmail.mockResolvedValue({ success: true });
    await outbox.queueEmail({ ...reset, organizationId: 5 });
    expect((await outbox.get(1, 5)).body_html).toBeNull(); // hidden while queued too

    await outbox.processQueue();

    expect(emailTransport.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ html: reset.html, operationalRecipient: true }));
    expect(row(1)).toMatchObject({ status: 'sent', body_html: null, body_text: null });
  });

  test('is not retried by staff once it failed', async () => {
    emailTransport.sendEmail.mockResolvedValue({ success: false, code: 'UNSAFE_HOST' });
    await outbox.queueEmail({ ...reset, organizationId: 5 });
    await outbox.processQueue();

    expect(row(1)).toMatchObject({ status: 'failed', body_html: null });
    await expect(outbox.retry(1, 5)).rejects.toMatchObject({ code: 'OUTBOX_NOT_RETRYABLE' });
  });
});

test('a billing email counts its real outcome in billing_emails_total, not its queueing', async () => {
  const { registry } = require('../src/utils/metricsRegistry');
  const count = (result) => {
    const line = registry.render().split('\n').find(l => l.startsWith(`billing_emails_total{kind="invoice",result="${result}"}`));
    return line ? Number(line.split(' ').pop()) : 0;
  };
  const before = { sent: count('sent'), failed: count('failed') };
  emailTransport.sendEmail
    .mockResolvedValueOnce({ success: true })
    .mockResolvedValueOnce({ success: false, code: 'UNSAFE_HOST' });
  await outbox.queueEmail({ ...clientEmail(), to: 'ana@example.com', html: '<p>x</p>', sourceType: 'invoice_email', sourceId: 1 });
  expect(count('sent')).toBe(before.sent);

  await outbox.processQueue();
  await outbox.queueEmail({ ...clientEmail(), to: 'ana@example.com', html: '<p>x</p>', sourceType: 'invoice_email', sourceId: 2 });
  await outbox.processQueue();

  expect(count('sent')).toBe(before.sent + 1);
  expect(count('failed')).toBe(before.failed + 1);
});

describe('crash and concurrency safety', () => {
  test('a worker that loses the claim to another makes no provider call', async () => {
    await outbox.enqueue(clientEmail());
    const original = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/SET status = 'claimed'/.test(sql)) {
        row(1).status = 'claimed'; // the other worker won
        return [{ affectedRows: 0 }];
      }
      return original(sql, params);
    });

    await outbox.processQueue();

    expect(emailTransport.sendEmail).not.toHaveBeenCalled();
  });

  test('stale recovery requeues only pre-I/O claims; a stale send becomes outcome_unknown, never queued', async () => {
    await outbox.processQueue();

    const sqls = db.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' '));
    const requeue = sqls.find(sql => /SET status = 'queued', claimed_at = NULL WHERE status = 'claimed'/.test(sql));
    const unknown = sqls.find(sql => /SET status = 'outcome_unknown'/.test(sql));
    expect(requeue).toMatch(/claimed_at < NOW\(\) - INTERVAL 5 MINUTE/);
    expect(unknown).toMatch(/WHERE status = 'sending' AND claimed_at < NOW\(\) - INTERVAL 15 MINUTE/);
    expect(sqls.some(sql => /SET status = 'queued'[^;]*WHERE status = 'sending'/.test(sql))).toBe(false);
  });

  test('the install-wide run skips isolated organizations on the primary and visits each isolated database', async () => {
    const scopes = [];
    db.withPrimaryContext = jest.fn(async (fn) => { scopes.push('primary'); return fn(); });
    db.withTenantContext = jest.fn(async (orgId, fn) => { scopes.push(orgId); return fn(); });
    const original = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => (/FROM organization_database_configs/.test(sql)
      ? [[{ organization_id: 8 }]]
      : original(sql, params)));

    try {
      await outbox.processQueue();
    } finally {
      delete db.withPrimaryContext;
      delete db.withTenantContext;
    }

    expect(scopes).toEqual(['primary', 'primary', 8]);
    const due = db.query.mock.calls.filter(([sql]) => /WHERE status = 'queued' AND next_attempt_at <= NOW\(\)/.test(sql));
    expect(due[0][0]).toMatch(/organization_id NOT IN \(\?\)/);
    expect(due[0][1]).toEqual([8]);
    expect(due[1][1]).toEqual([8]);
  });
});

describe('staff retry and cancel', () => {
  test('an outcome-unknown message needs explicit confirmation of a possible duplicate', async () => {
    await outbox.enqueue(clientEmail());
    row(1).status = 'outcome_unknown';

    await expect(outbox.retry(1, 5)).rejects.toMatchObject({ statusCode: 409, code: 'OUTBOX_POSSIBLE_DUPLICATE' });
    const retried = await outbox.retry(1, 5, { confirmPossibleDuplicate: true });

    expect(retried).toMatchObject({ status: 'queued', attempts: 0 });
  });

  test('a sent message is neither retried nor cancelled, and another organization\'s is not found', async () => {
    await outbox.enqueue(clientEmail());
    row(1).status = 'sent';

    await expect(outbox.retry(1, 5)).rejects.toMatchObject({ code: 'OUTBOX_NOT_RETRYABLE' });
    await expect(outbox.cancel(1, 5)).rejects.toMatchObject({ code: 'OUTBOX_NOT_CANCELLABLE' });
    await expect(outbox.retry(1, 6)).rejects.toMatchObject({ statusCode: 404 });
  });
});
