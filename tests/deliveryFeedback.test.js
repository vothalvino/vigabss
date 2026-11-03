'use strict';
// =============================================================================
// ASY-33 — provider bounces, complaints and STOP replies reach the client
// =============================================================================
// Nothing listened to them, so VigaBSS kept mailing dead addresses and
// texting people who replied STOP.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
const mockIsolated = jest.fn(async () => []);
jest.mock('../src/services/organizationFanOut', () => ({
  ...jest.requireActual('../src/services/organizationFanOut'),
  isolatedOrganizationIds: (...a) => mockIsolated(...a),
}));
const mockWritePreference = jest.fn(async () => {});
jest.mock('../src/services/clientCommunicationPreferenceService', () => ({
  ...jest.requireActual('../src/services/clientCommunicationPreferenceService'),
  writePreferenceWithRun: (...a) => mockWritePreference(...a),
}));

const request = require('supertest');
const db = require('../src/config/database');
const { recordProviderEvent } = require('../src/services/deliveryFeedbackService');
const app = require('../src/app');

const SENT = { id: 900, organization_id: 4, client_id: 31, channel: 'email', recipient: 'ana@example.com', client_contact_epoch: 2 };

function wire({ message = SENT, client = { email_contact_epoch: 2, phone_contact_epoch: 5 } } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM message_outbox WHERE provider_message_id = \?/.test(sql)) return [message ? [message] : []];
    if (/SELECT email_contact_epoch, phone_contact_epoch FROM clients/.test(sql)) return [[client]];
    return [{ affectedRows: 1 }];
  });
}
const suppression = () => db.query.mock.calls.find(([sql]) => /INSERT IGNORE INTO client_contact_suppressions/.test(sql));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WEBHOOK_DELIVERY_SECRET = 's3cret-delivery';
});
afterAll(() => { delete process.env.WEBHOOK_DELIVERY_SECRET; });

test('a hard bounce marks that address undeliverable at the epoch it was sent to', async () => {
  wire();

  await expect(recordProviderEvent({ providerMessageId: '<m1@isp>', event: 'bounce' })).resolves.toEqual({ applied: true });

  expect(suppression()[1]).toEqual([4, 31, 'email', 2, 'ana@example.com', 'bounce', '<m1@isp>']);
  expect(mockWritePreference).not.toHaveBeenCalled(); // not an opt-out: a new address works
});

test('a report about an address the client has since changed is ignored', async () => {
  wire({ client: { email_contact_epoch: 3, phone_contact_epoch: 5 } });

  await expect(recordProviderEvent({ providerMessageId: '<m1@isp>', event: 'bounce' })).resolves.toEqual({ applied: false, reason: 'address_changed' });
  expect(suppression()).toBeUndefined();
});

test('a spam complaint withdraws marketing consent on that channel only', async () => {
  wire();

  await recordProviderEvent({ providerMessageId: '<m1@isp>', event: 'complaint' });

  const withdraw = db.query.mock.calls.find(([sql]) => /UPDATE subscriber_consents SET withdrawn_at/.test(sql));
  expect(withdraw[0]).toMatch(/purpose = 'marketing'/);
  expect(withdraw[1]).toEqual([31, 4, 'email']);
  expect(mockWritePreference).not.toHaveBeenCalled();
});

test('an SMS STOP opts the client out of SMS', async () => {
  wire({ message: { ...SENT, channel: 'sms', recipient: '+5215555555555', client_contact_epoch: 5 } });

  await recordProviderEvent({ providerMessageId: 'SM-1', event: 'unsubscribe' });

  expect(mockWritePreference).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
    organizationId: 4, clientId: 31, channel: 'sms', optOut: true,
  }));
});

test('a message of an isolated organization is found in its own database', async () => {
  mockIsolated.mockResolvedValue([8]);
  db.withPrimaryContext = jest.fn(fn => fn());
  db.withTenantContext = jest.fn((_org, fn) => fn());
  let call = 0;
  db.query.mockImplementation(async (sql) => {
    if (/FROM message_outbox WHERE provider_message_id = \?/.test(sql)) {
      call++;
      return [call === 1 ? [] : [{ ...SENT, organization_id: 8 }]];
    }
    if (/FROM clients/.test(sql)) return [[{ email_contact_epoch: 2 }]];
    return [{ affectedRows: 1 }];
  });
  try {
    await expect(recordProviderEvent({ providerMessageId: '<m1@isp>', event: 'bounce' })).resolves.toEqual({ applied: true });
    expect(db.withTenantContext).toHaveBeenCalledWith(8, expect.any(Function));
  } finally {
    delete db.withPrimaryContext;
    delete db.withTenantContext;
    mockIsolated.mockResolvedValue([]);
  }
});

describe('POST /communication/delivery-webhook', () => {
  const post = body => request(app)
    .post('/api/v1/communication/delivery-webhook')
    .set('X-Webhook-Secret', 's3cret-delivery')
    .send(body);

  test('a generic hard bounce is applied', async () => {
    wire();
    const res = await post({ provider_message_id: '<m1@isp>', status: 'bounced' });
    expect(res.status).toBe(200);
    expect(res.body.feedback).toEqual({ applied: true });
    expect(suppression()).toBeDefined();
  });

  test('a soft bounce (permanent: false) suppresses nothing', async () => {
    wire();
    await post({ provider_message_id: '<m1@isp>', status: 'bounced', permanent: false });
    expect(suppression()).toBeUndefined();
  });

  test('a Twilio STOP (ErrorCode 21610) is an unsubscribe', async () => {
    wire({ message: { ...SENT, channel: 'sms', recipient: '+5215555555555', client_contact_epoch: 5 } });
    const res = await request(app)
      .post('/api/v1/communication/delivery-webhook')
      .set('X-Webhook-Secret', 's3cret-delivery')
      .type('form')
      .send({ MessageSid: 'SM-1', MessageStatus: 'undelivered', ErrorCode: '21610' });
    expect(res.status).toBe(200);
    expect(mockWritePreference).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ channel: 'sms', optOut: true }));
  });

  test('a report without the secret changes nothing', async () => {
    wire();
    const res = await request(app).post('/api/v1/communication/delivery-webhook').send({ provider_message_id: '<m1@isp>', status: 'bounced' });
    expect(res.status).toBe(401);
    expect(suppression()).toBeUndefined();
  });
});
