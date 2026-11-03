'use strict';

const mockQuery = jest.fn();
const mockWithTenantContext = jest.fn(async (_organizationId, callback) => callback());
const mockWithPrimaryContext = jest.fn(async callback => callback());

jest.mock('../src/config/database', () => ({
  query: mockQuery,
  withTenantContext: mockWithTenantContext,
  withPrimaryContext: mockWithPrimaryContext,
}));

const mockGetOrganizationDeliveryState = jest.fn();
const mockEvaluateClientCommunication = jest.fn();
const mockBlockedResult = jest.fn(code => ({
  success: false,
  skipped: true,
  code,
  error: 'Client communication preference blocks this delivery.',
}));
const mockBlockCodes = Object.freeze({
  ORGANIZATION_INACTIVE: 'ORGANIZATION_INACTIVE',
  ORGANIZATION_REQUIRED: 'CLIENT_ORGANIZATION_REQUIRED',
  CLIENT_INACTIVE: 'CLIENT_INACTIVE',
  CLIENT_NOT_FOUND: 'CLIENT_NOT_FOUND',
  CONTACT_MISMATCH: 'CLIENT_COMMUNICATION_CONTACT_MISMATCH',
  OPTED_OUT: 'CLIENT_COMMUNICATION_OPTED_OUT',
  CONSENT_REQUIRED: 'CLIENT_MARKETING_CONSENT_REQUIRED',
});
jest.mock('../src/services/clientCommunicationPreferenceService', () => ({
  getOrganizationDeliveryState: mockGetOrganizationDeliveryState,
  evaluateClientCommunication: mockEvaluateClientCommunication,
  assertMessageClass: jest.fn(messageClass => messageClass),
  blockedResult: mockBlockedResult,
  BLOCK_CODES: mockBlockCodes,
}));

const https = require('https');
const http = require('http');
jest.spyOn(https, 'request');
jest.spyOn(http, 'request');

const mockEnqueue = jest.fn(async () => ({ queued: true, id: 501 }));
jest.mock('../src/services/messageOutbox', () => ({ enqueue: (...a) => mockEnqueue(...a) }));

const smsTransport = require('../src/services/smsTransport');

function mockHttpsRequest({ statusCode = 201, body = '{}' } = {}) {
  const { EventEmitter } = require('events');
  https.request.mockImplementationOnce((_options, callback) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;
    const request = new EventEmitter();
    request.write = jest.fn();
    request.end = jest.fn(() => {
      callback(response);
      response.emit('data', body);
      response.emit('end');
    });
    request.destroy = jest.fn(error => request.emit('error', error));
    return request;
  });
}

const ACTIVE = { active: true, epoch: 8 };

describe('smsTransport — authoritative client communication enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    https.request.mockReset();
    http.request.mockReset();
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM;
    delete process.env.TWILIO_WHATSAPP_FROM;
    delete process.env.SMS_PROVIDER;
    delete process.env.SMS_PROVIDER_URL;
    delete process.env.SMS_PROVIDER_API_KEY;
    delete process.env.REDIS_URL;
    mockGetOrganizationDeliveryState.mockResolvedValue(ACTIVE);
    mockEvaluateClientCommunication.mockResolvedValue({ allowed: true, code: null, contactEpoch: 19 });
    mockQuery.mockResolvedValue([{ affectedRows: 1, insertId: 1 }]);
  });

  test('detects configured providers deterministically', () => {
    expect(smsTransport.detectProvider()).toBeNull();
    process.env.TWILIO_ACCOUNT_SID = 'ACxxx';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    expect(smsTransport.detectProvider()).toBe('twilio');
    process.env.SMS_PROVIDER = 'generic';
    process.env.SMS_PROVIDER_URL = 'https://sms.example.com/send';
    expect(smsTransport.detectProvider()).toBe('generic');
  });

  test.each(['sms', 'whatsapp'])('DND blocks direct %s before provider I/O', async channel => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    mockEvaluateClientCommunication.mockResolvedValueOnce({
      allowed: false,
      code: 'CLIENT_COMMUNICATION_OPTED_OUT',
    });

    const result = await smsTransport.sendSms({
      organizationId: 7,
      clientId: 44,
      channel,
      messageClass: 'transactional',
      to: '+526141234567',
      body: 'Invoice notice',
    });

    expect(result).toMatchObject({
      success: false,
      code: 'CLIENT_COMMUNICATION_OPTED_OUT',
    });
    expect(mockEvaluateClientCommunication).toHaveBeenCalledWith({
      organizationId: 7,
      clientId: 44,
      channel,
      destination: '+526141234567',
      messageClass: 'transactional',
    });
    expect(https.request).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('organization_epoch'),
      expect.arrayContaining([7, 8, 44, '+526141234567', channel, 'transactional']),
    );
  });

  test('successful client SMS rechecks the organization and records class/epoch', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_FROM = '+15005550001';
    mockHttpsRequest({ body: JSON.stringify({ sid: 'SM123', status: 'queued' }) });

    const result = await smsTransport.sendSms({
      organizationId: 7,
      clientId: 44,
      channel: 'sms',
      messageClass: 'security',
      to: '+526141234567',
      body: 'Your code is 123456',
    });

    expect(result).toEqual({ success: true, messageId: 'SM123' });
    expect(mockGetOrganizationDeliveryState).toHaveBeenCalledTimes(2);
    expect(https.request).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'api.twilio.com' }),
      expect.any(Function),
    );
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(expect.arrayContaining([7, 8, 44, 'security', 'SM123', 'sent']));
  });

  test('an explicit provider-delivered result is a successful direct SMS', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_FROM = '+15005550001';
    mockHttpsRequest({ body: JSON.stringify({ sid: 'SM-DELIVERED', status: 'delivered' }) });

    const result = await smsTransport.sendSms({
      organizationId: 7,
      clientId: 44,
      channel: 'sms',
      messageClass: 'transactional',
      to: '+526141234567',
      body: 'Delivery confirmation',
    });

    expect(result).toEqual({ success: true, messageId: 'SM-DELIVERED' });
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(expect.arrayContaining(['SM-DELIVERED', 'delivered']));
    expect(params[params.length - 1]).toBeInstanceOf(Date);
  });

  test('organization epoch change immediately before dispatch prevents provider I/O', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    mockGetOrganizationDeliveryState
      .mockResolvedValueOnce({ active: true, epoch: 8 })
      .mockResolvedValueOnce({ active: true, epoch: 9 });

    const result = await smsTransport.sendSms({
      organizationId: 7,
      clientId: 44,
      channel: 'sms',
      messageClass: 'transactional',
      to: '+526141234567',
      body: 'stale',
    });

    expect(result).toMatchObject({ success: false, code: 'ORGANIZATION_INACTIVE' });
    expect(https.request).not.toHaveBeenCalled();
  });

  test.each(['sendSms', 'queueSms'])(
    '%s rejects missing client attribution before database or provider I/O',
    async method => {
      await expect(smsTransport[method]({
        organizationId: 7,
        to: '+526141234567',
        body: 'Unattributed client work',
        messageClass: 'transactional',
      })).rejects.toMatchObject({ code: 'CLIENT_ATTRIBUTION_REQUIRED' });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(https.request).not.toHaveBeenCalled();
    },
  );

  test.each(['sendSms', 'queueSms'])(
    '%s rejects a client whose organization ownership became NULL',
    async method => {
      await expect(smsTransport[method]({
        organizationId: null,
        clientId: 44,
        to: '+526141234567',
        body: 'Orphaned client work',
        messageClass: 'transactional',
      })).rejects.toMatchObject({ code: 'CLIENT_ATTRIBUTION_REQUIRED' });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(https.request).not.toHaveBeenCalled();
    },
  );

  test('inactive client blocks direct SMS before provider I/O', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    mockEvaluateClientCommunication.mockResolvedValueOnce({
      allowed: false,
      code: 'CLIENT_INACTIVE',
    });

    await expect(smsTransport.sendSms({
      organizationId: 7,
      clientId: 44,
      channel: 'sms',
      messageClass: 'transactional',
      to: '+526141234567',
      body: 'Inactive client work',
    })).resolves.toMatchObject({ success: false, skipped: true, code: 'CLIENT_INACTIVE' });
    expect(https.request).not.toHaveBeenCalled();
  });

  test('queueSms writes to the message outbox (ASY-33), never straight to the provider', async () => {
    await expect(smsTransport.queueSms({
      organizationId: 7, clientId: 44, channel: 'whatsapp', messageClass: 'transactional',
      to: '+526141234567', body: 'Pago recibido', templateId: 3,
    })).resolves.toEqual({ queued: true, id: 501 });

    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'whatsapp', organizationId: 7, clientId: 44, messageClass: 'transactional',
      recipient: '+526141234567', bodyText: 'Pago recibido', payload: { template_id: 3 },
    }));
    expect(https.request).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  describe('a failure says whether the provider provably never took the message', () => {
    const send = () => smsTransport.sendSms({
      organizationId: 7, clientId: 44, channel: 'sms', messageClass: 'transactional',
      to: '+526141234567', body: 'Aviso',
    });
    beforeEach(() => {
      process.env.TWILIO_ACCOUNT_SID = 'ACtest';
      process.env.TWILIO_AUTH_TOKEN = 'token';
      process.env.TWILIO_FROM = '+15005550001';
    });

    test('a 503 from the provider is unsent and worth retrying', async () => {
      mockHttpsRequest({ statusCode: 503, body: JSON.stringify({ message: 'busy' }) });
      const result = await send();
      expect(result).toMatchObject({ success: false, unsent: true });
      expect(result.permanent).toBeUndefined();
    });

    test('a 400 (invalid number) is unsent and permanent', async () => {
      mockHttpsRequest({ statusCode: 400, body: JSON.stringify({ code: 21211, message: 'Invalid To' }) });
      await expect(send()).resolves.toMatchObject({ success: false, unsent: true, permanent: true, code: '21211' });
    });

    test('a timeout may have sent it: neither unsent nor permanent', async () => {
      const { EventEmitter } = require('events');
      https.request.mockImplementationOnce(() => {
        const request = new EventEmitter();
        request.write = jest.fn();
        request.end = jest.fn(() => request.emit('timeout'));
        request.destroy = jest.fn(error => request.emit('error', error));
        return request;
      });
      const result = await send();
      expect(result.success).toBe(false);
      expect(result.unsent).toBeUndefined();
    });

    test('no provider configured is unsent', async () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      await expect(send()).resolves.toMatchObject({ success: false, unsent: true, code: 'SMS_PROVIDER_NOT_CONFIGURED' });
    });
  });
});
