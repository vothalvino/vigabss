'use strict';

const mockQuery = jest.fn();
const mockWithTenantContext = jest.fn(async (_organizationId, callback) => callback());

jest.mock('../src/config/database', () => ({
  query: mockQuery,
  withTenantContext: mockWithTenantContext,
}));

jest.mock('../src/config', () => ({
  whatsapp: { phoneNumberId: '', accessToken: '', graphVersion: 'v20.0' },
}));

const mockGetOrganizationDeliveryState = jest.fn();
const mockEvaluateClientCommunication = jest.fn();
jest.mock('../src/services/clientCommunicationPreferenceService', () => ({
  getOrganizationDeliveryState: mockGetOrganizationDeliveryState,
  evaluateClientCommunication: mockEvaluateClientCommunication,
  BLOCK_CODES: {
    CONTACT_MISMATCH: 'CLIENT_COMMUNICATION_CONTACT_MISMATCH',
  },
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

const https = require('https');
jest.spyOn(https, 'request');
const whatsappOutbound = require('../src/services/whatsappOutbound');

describe('whatsappOutbound client communication enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    https.request.mockReset();
    mockQuery.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
    mockGetOrganizationDeliveryState.mockReset().mockResolvedValue({ active: true, epoch: 4 });
    mockEvaluateClientCommunication.mockReset().mockResolvedValue({
      allowed: true,
      code: null,
      contactEpoch: 9,
    });
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'token';
  });

  afterAll(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    https.request.mockRestore();
  });

  test.each([
    [null, 'CLIENT_ORGANIZATION_REQUIRED'],
    [7, 'CLIENT_INACTIVE'],
    [7, 'CLIENT_COMMUNICATION_OPTED_OUT'],
  ])('blocks bound client reply before provider I/O for org=%s code=%s', async (organizationId, code) => {
    mockEvaluateClientCommunication.mockResolvedValueOnce({ allowed: false, code });

    const result = await whatsappOutbound.sendReply({
      provider: 'twilio',
      organizationId,
      clientId: 44,
      to: '+526141234567',
      body: 'Support reply',
    });

    expect(result).toMatchObject({ success: false, skipped: true, code });
    expect(mockEvaluateClientCommunication).toHaveBeenCalledWith({
      organizationId,
      clientId: 44,
      channel: 'whatsapp',
      destination: '+526141234567',
      messageClass: 'support_reply',
    });
    expect(https.request).not.toHaveBeenCalled();
    if (organizationId === null) {
      expect(mockQuery).not.toHaveBeenCalled();
    } else {
      expect(mockWithTenantContext).toHaveBeenCalledWith(7, expect.any(Function));
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringMatching(/message_class[\s\S]*'support_reply'/),
        expect.arrayContaining([7, 44, 'failed', code]),
      );
    }
  });
});

describe('whatsappOutbound tappable replies (Meta)', () => {
  const config = require('../src/config');
  const { EventEmitter } = require('events');
  let sentBodies;

  // Each https.request answers with the next queued { status, body }.
  function answerWith(...responses) {
    sentBodies = [];
    https.request.mockImplementation((_options, onResponse) => {
      const req = new EventEmitter();
      req.write = (data) => { sentBodies.push(JSON.parse(data)); };
      req.end = () => {
        const { status, body } = responses.shift();
        const res = new EventEmitter();
        res.statusCode = status;
        onResponse(res);
        res.emit('data', JSON.stringify(body));
        res.emit('end');
      };
      req.destroy = jest.fn();
      return req;
    });
  }
  const OK = { status: 200, body: { messages: [{ id: 'wamid.1' }] } };
  const send = interactive => whatsappOutbound.sendReply({
    provider: 'meta', to: '+525512345678', body: 'Reply CONFIRM to continue.', interactive,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    https.request.mockReset();
    mockGetOrganizationDeliveryState.mockReset().mockResolvedValue({ active: true, epoch: 0 });
    config.whatsapp.phoneNumberId = '123456789012345';
    config.whatsapp.accessToken = 'example-token';
  });
  // The suite above restored its spy on the way out.
  beforeAll(() => { jest.spyOn(https, 'request'); });
  afterAll(() => {
    https.request.mockRestore();
    config.whatsapp.phoneNumberId = '';
    config.whatsapp.accessToken = '';
  });

  test('sends buttons as a Meta interactive message', async () => {
    answerWith(OK);
    const result = await send({ body: 'Shall I change it?', buttons: [{ id: 'confirm', title: 'Yes, change it' }, { id: 'cancel', title: 'Cancel' }] });
    expect(result.success).toBe(true);
    expect(sentBodies).toEqual([{
      messaging_product: 'whatsapp', to: '525512345678', type: 'interactive',
      interactive: {
        type: 'button', body: { text: 'Shall I change it?' },
        action: { buttons: [
          { type: 'reply', reply: { id: 'confirm', title: 'Yes, change it' } },
          { type: 'reply', reply: { id: 'cancel', title: 'Cancel' } },
        ] },
      },
    }]);
  });

  test('sends a list, clipping titles to Meta\'s limits', async () => {
    answerWith(OK);
    await send({ body: 'Which service?', list: { button: 'See options', rows: [{ id: '1', title: '1. A plan with a very long name indeed', description: 'Home' }] } });
    const { interactive } = sentBodies[0];
    expect(interactive.type).toBe('list');
    expect(interactive.action.button).toBe('See options');
    expect(interactive.action.sections[0].rows[0]).toEqual({ id: '1', title: '1. A plan with a very l…', description: 'Home' });
    expect(interactive.action.sections[0].rows[0].title.length).toBeLessThanOrEqual(24);
  });

  test('falls back to the plain text when Meta refuses the interactive form', async () => {
    answerWith({ status: 400, body: { error: { message: 'Invalid parameter', code: 100 } } }, OK);
    const result = await send({ body: 'Shall I change it?', buttons: [{ id: 'confirm', title: 'Yes' }] });
    expect(result.success).toBe(true);
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[1]).toEqual({
      messaging_product: 'whatsapp', to: '525512345678', type: 'text',
      text: { preview_url: false, body: 'Reply CONFIRM to continue.' },
    });
  });

  test('a refused reply is reported to the settings service, and a delivered one clears it', async () => {
    const settings = require('../src/services/whatsappSettingsService');
    const failure = jest.spyOn(settings, 'noteSendFailure').mockResolvedValue();
    const success = jest.spyOn(settings, 'noteSendSuccess').mockResolvedValue();

    answerWith({ status: 401, body: { error: { message: 'Authentication Error', code: 190 } } });
    expect((await send(null)).success).toBe(false);
    expect(failure).toHaveBeenCalledWith({ message: 'Authentication Error', code: '190' });
    expect(success).not.toHaveBeenCalled();

    answerWith(OK);
    expect((await send(null)).success).toBe(true);
    expect(success).toHaveBeenCalledTimes(1);
    failure.mockRestore(); success.mockRestore();
  });

  test('a reply without options is plain text', async () => {
    answerWith(OK);
    await send(null);
    expect(sentBodies[0].type).toBe('text');
  });

  test('metaInteractive refuses what Meta would reject', () => {
    const { metaInteractive } = whatsappOutbound;
    const four = ['a', 'b', 'c', 'd'].map(id => ({ id, title: id }));
    expect(metaInteractive({ body: 'x', buttons: four })).toBeNull();
    expect(metaInteractive({ body: '', buttons: four.slice(0, 2) })).toBeNull();
    expect(metaInteractive({ body: 'x'.repeat(1025), buttons: four.slice(0, 2) })).toBeNull();
    expect(metaInteractive({ body: 'x', list: { button: 'Options', rows: Array.from({ length: 11 }, (_, i) => ({ id: String(i), title: 't' })) } })).toBeNull();
    expect(metaInteractive({ body: 'x' })).toBeNull();
    expect(metaInteractive(null)).toBeNull();
  });
});

