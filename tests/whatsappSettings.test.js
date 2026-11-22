// The WhatsApp connection could only be configured in the server's environment
// file. It can now be managed from the app: stored in the install-wide
// settings table (secrets encrypted), laid over config.whatsapp, and visible
// only to the install operator — never returning a secret.

const request = require('supertest');

const mockRows = new Map();
jest.mock('../src/config/database', () => {
  const query = jest.fn(async (sql, params = []) => {
    if (/FROM settings WHERE setting_key IN/.test(sql)) {
      return [[...mockRows.entries()].map(([setting_key, setting_value]) => ({ setting_key, setting_value }))];
    }
    if (/INSERT INTO settings/.test(sql)) { mockRows.set(params[0], params[1]); return [{ affectedRows: 1 }]; }
    return [[]];
  });
  return {
    query, queryReplica: query, execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
    pool: { end: jest.fn() }, withPrimaryContext: fn => fn(),
  };
});
jest.mock('../src/utils/encryption', () => ({
  encrypt: v => `enc(${v})`,
  decrypt: v => String(v).replace(/^enc\((.*)\)$/, '$1'),
}));
let mockOperator = true;
jest.mock('../src/services/installOperator', () => ({
  isInstallOperator: async () => mockOperator,
  isInstallOperatorUser: async () => mockOperator,
  OPERATOR_ONLY_MESSAGE: 'Only the install operator can do this.',
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 8, role: 'admin', organization_id: 1 }; next(); },
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const config = require('../src/config');
const auditLog = require('../src/services/auditLog');
const service = require('../src/services/whatsappSettingsService');
const app = require('../src/app');

const SECRET_VALUES = ['EAAG-access-token-value', 'app-secret-value-1234', 'verify-token-value'];

beforeEach(async () => {
  mockRows.clear();
  mockOperator = true;
  jest.clearAllMocks();
  await service.refresh();
});
afterAll(() => service.stop());

describe('saving', () => {
  test('stores secrets encrypted and lays every value over the running config', async () => {
    await service.save({
      phone_number_id: '123456789012345', business_number: '+5215512345678',
      access_token: SECRET_VALUES[0], app_secret: SECRET_VALUES[1], verify_token: SECRET_VALUES[2],
    });
    expect(mockRows.get('whatsapp_phone_number_id')).toBe('123456789012345');
    expect(mockRows.get('whatsapp_access_token')).toBe(`enc(${SECRET_VALUES[0]})`);
    expect(mockRows.get('whatsapp_app_secret')).toBe(`enc(${SECRET_VALUES[1]})`);
    expect(mockRows.get('whatsapp_verify_token')).toBe(`enc(${SECRET_VALUES[2]})`);
    // What the webhook and the sender read at call time.
    expect(config.whatsapp.phoneNumberId).toBe('123456789012345');
    expect(config.whatsapp.accessToken).toBe(SECRET_VALUES[0]);
    expect(config.whatsapp.appSecret).toBe(SECRET_VALUES[1]);
    expect(config.whatsapp.verifyToken).toBe(SECRET_VALUES[2]);
  });

  test('an omitted field is unchanged; an empty one is removed', async () => {
    await service.save({ phone_number_id: '123456789012345', access_token: SECRET_VALUES[0] });
    await service.save({ business_number: '5215512345678' });
    expect(config.whatsapp.accessToken).toBe(SECRET_VALUES[0]);
    await service.save({ access_token: '' });
    expect(config.whatsapp.accessToken).toBe('');
    expect(service.getView().has_access_token).toBe(false);
    expect(config.whatsapp.phoneNumberId).toBe('123456789012345');
  });

  test.each([
    [{ phone_number_id: 'abc' }, /phone_number_id/],
    [{ business_number: 'not a number' }, /business_number/],
    [{ access_token: 'short' }, /access_token/],
    [{ verify_token: 'line\nbreak-token' }, /verify_token/],
    [{ app_secret: 12345678 }, /app_secret/],
  ])('rejects %j without storing anything', async (input, message) => {
    await expect(service.save(input)).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(message) });
    expect(mockRows.size).toBe(0);
  });
});

describe('the view', () => {
  test('never contains a secret, only whether each is set and from where', async () => {
    await service.save({
      phone_number_id: '123456789012345', access_token: SECRET_VALUES[0],
      app_secret: SECRET_VALUES[1], verify_token: SECRET_VALUES[2],
    });
    const view = service.getView();
    const text = JSON.stringify(view);
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
    expect(view).toMatchObject({
      phone_number_id: '123456789012345', has_access_token: true, has_app_secret: true, has_verify_token: true,
      can_receive: true, can_send: true,
    });
    expect(view.sources.access_token).toBe('settings');
    expect(view.webhook_url).toMatch(/\/api\/v1\/whatsapp\/webhook$/);
  });

  test('says what is missing for receiving and for sending', () => {
    const view = service.getView();
    expect(view.can_receive).toBe(false);
    expect(view.can_send).toBe(false);
  });
});

describe('testing the connection', () => {
  test('asks Meta about the configured number and reports its name', async () => {
    await service.save({ phone_number_id: '123456789012345', access_token: SECRET_VALUES[0] });
    const get = jest.fn().mockResolvedValue({ status: 200, body: { display_phone_number: '+52 55 1234 5678', verified_name: 'Example ISP' } });
    const result = await service.testConnection({ get });
    expect(result).toEqual({ ok: true, display_phone_number: '+52 55 1234 5678', verified_name: 'Example ISP' });
    expect(get.mock.calls[0][0]).toMatch(/^\/v\d+\.\d+\/123456789012345\?fields=/);
    expect(get.mock.calls[0][1]).toBe(SECRET_VALUES[0]);
  });

  test('passes on Meta\'s reason when the token or number is wrong', async () => {
    await service.save({ phone_number_id: '123456789012345', access_token: SECRET_VALUES[0] });
    const get = jest.fn().mockResolvedValue({ status: 401, body: { error: { message: 'Error validating access token: Session has expired' } } });
    expect(await service.testConnection({ get })).toEqual({ ok: false, error: 'Error validating access token: Session has expired' });
  });

  test('does not call Meta when the number or token is missing', async () => {
    const get = jest.fn();
    expect((await service.testConnection({ get })).ok).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('failing replies', () => {
  test('a refused reply is remembered and shown, and flagged when the token is the cause', async () => {
    await service.noteSendFailure({ message: 'Authentication Error', code: 190 });
    const view = service.getView();
    expect(view.send_failure).toMatchObject({ message: 'Authentication Error', auth: true, count: 1 });
    expect(view.send_failure.since).toBe(view.send_failure.last);
    expect(JSON.parse(mockRows.get('whatsapp_last_send_failure'))).toMatchObject({ message: 'Authentication Error', code: '190' });
  });

  test('a run of failures is one record that keeps when it started', async () => {
    await service.noteSendFailure({ message: 'Authentication Error', code: 190 });
    const { since } = service.getView().send_failure;
    await service.noteSendFailure({ message: 'Authentication Error', code: 190 });
    await service.noteSendFailure({ message: 'Authentication Error', code: 190 });
    expect(service.getView().send_failure).toMatchObject({ count: 3, since });
  });

  test('a failure that is not about the token is shown without the token hint', async () => {
    await service.noteSendFailure({ message: '(#131030) Recipient phone number not in allowed list', code: 131030 });
    expect(service.getView().send_failure.auth).toBe(false);
  });

  test('the next reply that goes out clears it', async () => {
    await service.noteSendFailure({ message: 'Authentication Error', code: 190 });
    await service.noteSendSuccess();
    expect(service.getView().send_failure).toBeNull();
    expect(mockRows.get('whatsapp_last_send_failure')).toBe('');
  });

  test('saving a new access token clears it', async () => {
    await service.noteSendFailure({ message: 'Authentication Error', code: 190 });
    await service.save({ access_token: SECRET_VALUES[0] });
    expect(service.getView().send_failure).toBeNull();
  });

  test('another server instance sees it after its next refresh', async () => {
    mockRows.set('whatsapp_last_send_failure', JSON.stringify({ message: 'Authentication Error', code: '190', since: '2026-11-22T05:17:35.000Z', last: '2026-11-22T05:17:35.000Z', count: 2 }));
    await service.refresh();
    expect(service.getView().send_failure).toMatchObject({ count: 2, auth: true });
  });

  test('nothing is written while replies work, and recording never throws', async () => {
    const db = require('../src/config/database');
    db.query.mockClear();
    await service.noteSendSuccess();
    expect(db.query).not.toHaveBeenCalled();
    db.query.mockRejectedValueOnce(new Error('db down'));
    await expect(service.noteSendFailure({ message: 'x' })).resolves.toBeUndefined();
  });

  test('the message is never a secret: it is Meta\'s text, cut to a sane length', async () => {
    await service.noteSendFailure({ message: 'e'.repeat(1000) });
    expect(service.getView().send_failure.message).toHaveLength(300);
  });
});

describe('the routes', () => {
  test('only the install operator may read, change or test the connection', async () => {
    mockOperator = false;
    for (const call of [
      request(app).get('/api/v1/whatsapp-settings'),
      request(app).put('/api/v1/whatsapp-settings').send({ phone_number_id: '123456789012345' }),
      request(app).post('/api/v1/whatsapp-settings/test'),
    ]) {
      const res = await call;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSTALL_OPERATOR_ONLY');
    }
    expect(mockRows.size).toBe(0);
  });

  test('PUT saves, answers with the view and no secret, and audits field names only', async () => {
    const res = await request(app).put('/api/v1/whatsapp-settings')
      .send({ phone_number_id: '123456789012345', access_token: SECRET_VALUES[0] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ phone_number_id: '123456789012345', has_access_token: true });
    expect(JSON.stringify(res.body)).not.toContain(SECRET_VALUES[0]);
    const entry = auditLog.log.mock.calls[0][0];
    expect(entry.summary).toMatch(/phone_number_id, access_token/);
    expect(JSON.stringify(entry)).not.toContain(SECRET_VALUES[0]);
  });

  test('PUT answers 422 for a bad value', async () => {
    const res = await request(app).put('/api/v1/whatsapp-settings').send({ phone_number_id: 'abc' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_WHATSAPP_SETTING');
  });
});
