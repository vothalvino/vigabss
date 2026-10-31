// =============================================================================
// NET-10 — network secrets are write-only and encrypted where possible
// =============================================================================
// GET /nas returned the RADIUS shared secret, devices and discovery scans the
// SNMP community, the ONU routes LOID/Wi-Fi passwords and bandwidth test
// servers the iperf token — to every *.view holder, which includes the
// read-only role. The ONU passwords were also stored exactly as sent.
// =============================================================================

const TEST_KEY = 'b'.repeat(64);
process.env.ENCRYPTION_KEY = TEST_KEY;

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/models/Nas');
jest.mock('../src/models/Device');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const Nas = require('../src/models/Nas');
const Device = require('../src/models/Device');
const { decrypt } = require('../src/utils/encryption');
const app = require('../src/app');

const NAS_ROW = { id: 3, organization_id: 1, name: 'core', secret: 'radius-shared', api_password_encrypted: 'x' };
const DEVICE_ROW = { id: 4, organization_id: 1, name: 'olt', snmp_community: 'private-comm' };

const tokenFor = role => jwt.sign({ sub: 1, email: 'u@test.com', role, orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const call = (method, path, { role = 'admin', body } = {}) => {
  const req = request(app)[method](`/api/v1${path}`)
    .set('Authorization', `Bearer ${tokenFor(role)}`).set('X-Org-Id', '1');
  return body ? req.send(body) : req;
};

afterAll(() => { delete process.env.ENCRYPTION_KEY; });

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue([[]]);
  User.findById.mockImplementation(async () => ({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 }));
  Nas.findAll.mockResolvedValue({ data: [NAS_ROW], total: 1 });
  Nas.findByIdOrFail.mockResolvedValue(NAS_ROW);
  Nas.findById.mockResolvedValue(NAS_ROW);
  Device.findByIdOrFail.mockResolvedValue(DEVICE_ROW);
  Device.findById.mockResolvedValue(DEVICE_ROW);
  Device.create.mockImplementation(async data => ({ id: 9, ...data }));
  Device.update.mockImplementation(async (_id, data) => ({ ...DEVICE_ROW, ...data }));
});

describe('NAS RADIUS shared secret', () => {
  test('GET /nas/:id returns has_secret, not the secret', async () => {
    const res = await call('get', '/nas/3');
    expect(res.status).toBe(200);
    expect(res.body.data.secret).toBeUndefined();
    expect(res.body.data.has_secret).toBe(true);
  });

  test('GET /nas/:id/secret requires radius.credentials.view', async () => {
    User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'readonly', organization_id: 1 });
    User.getPermissions.mockResolvedValue(['devices.view']);
    const denied = await call('get', '/nas/3/secret', { role: 'readonly' });
    expect(denied.status).toBe(403);

    User.getPermissions.mockResolvedValue(['devices.view', 'radius.credentials.view']);
    const allowed = await call('get', '/nas/3/secret', { role: 'readonly' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.secret).toBe('radius-shared');
  });

  test('an edit with a blank secret keeps the stored one', async () => {
    Nas.update.mockResolvedValue(NAS_ROW);
    await call('put', '/nas/3', { body: { name: 'core-2', secret: '' } });
    expect(Nas.update.mock.calls[0][1]).not.toHaveProperty('secret');
  });
});

describe('SNMP community', () => {
  test('device responses carry has_snmp_community', async () => {
    const res = await call('get', '/devices/4');
    expect(res.body.data.snmp_community).toBeUndefined();
    expect(res.body.data.has_snmp_community).toBe(true);
  });

  test('a new community is stored encrypted and the poller decrypts it', async () => {
    db.query.mockResolvedValue([[{ n: 0 }]]);
    await call('put', '/devices/4', { body: { snmp_community: 'new-comm' } });
    const stored = Device.update.mock.calls[0][1].snmp_community;
    expect(stored).not.toBe('new-comm');
    expect(decrypt(stored)).toBe('new-comm');
  });

  test('a blank community on edit keeps the stored one', async () => {
    await call('put', '/devices/4', { body: { name: 'olt-2', snmp_community: '' } });
    expect(Device.update.mock.calls[0][1]).not.toHaveProperty('snmp_community');
  });
});

describe('ONU passwords', () => {
  test('a LOID password is sealed on write and never returned', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/^INSERT INTO onu_details/.test(sql)) return [{ insertId: 11 }];
      if (/SELECT \* FROM onu_details WHERE id = \?/.test(sql)) return [[{ id: 11, loid: 'L1', loid_password_encrypted: 'cipher' }]];
      return [[]];
    });

    const res = await call('post', '/onu-management/details', { body: { device_id: 4, loid: 'L1', loid_password: 'loid-pass' } });

    expect(res.status).toBe(201);
    const [, values] = db.query.mock.calls.find(([sql]) => /^INSERT INTO onu_details/.test(sql));
    expect(values).not.toContain('loid-pass');
    expect(values.map(v => (typeof v === 'string' ? decrypt(v) : v))).toContain('loid-pass');
    expect(res.body.data.loid_password_encrypted).toBeUndefined();
    expect(res.body.data.has_loid_password).toBe(true);
  });

  test('writing the encrypted column directly is refused', async () => {
    const res = await call('post', '/onu-management/omci-configs', { body: { device_id: 4, config_type: 'wifi', wifi_password_encrypted: 'plain' } });
    expect(res.status).toBe(422);
    expect(db.query.mock.calls.some(([sql]) => /^INSERT INTO onu_omci_configs/.test(sql))).toBe(false);
  });

  test('OMCI config lists carry has_wifi_password', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/COUNT\(\*\)/.test(sql)) return [[{ total: 1 }]];
      return [[{ id: 1, wifi_ssid: 'Home', wifi_password_encrypted: 'cipher' }]];
    });
    const res = await call('get', '/onu-management/omci-configs');
    expect(res.body.data[0].wifi_password_encrypted).toBeUndefined();
    expect(res.body.data[0].has_wifi_password).toBe(true);
  });
});

describe('bandwidth test server tokens', () => {
  test('lists, including install-wide servers, never return the token', async () => {
    db.query.mockResolvedValue([[{ id: 1, organization_id: null, name: 'Global', auth_token: 'iperf-secret' }]]);
    const res = await call('get', '/bandwidth-test-servers');
    expect(res.body.data[0].auth_token).toBeUndefined();
    expect(res.body.data[0].has_auth_token).toBe(true);
  });

  test('a new token is stored encrypted', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/^\s*INSERT INTO bandwidth_test_servers/.test(sql)) return [{ insertId: 2 }];
      if (/SELECT \* FROM bandwidth_test_servers WHERE id = \?/.test(sql)) return [[{ id: 2, auth_token: 'cipher' }]];
      return [[]];
    });
    await call('post', '/bandwidth-test-servers', { body: { name: 'S', host: 'iperf.example.com', auth_token: 'tok' } });
    const [, values] = db.query.mock.calls.find(([sql]) => /INSERT INTO bandwidth_test_servers/.test(sql));
    expect(values).not.toContain('tok');
    expect(values.some(v => typeof v === 'string' && decrypt(v) === 'tok')).toBe(true);
  });
});

describe('credentials:encrypt backfill', () => {
  const { encryptPlaintextCredentials } = require('../src/scripts/encrypt-plaintext-credentials');

  test('encrypts stored network credentials and leaves values too long for their column', async () => {
    const fake = {
      query: jest.fn(async (sql) => {
        if (/FROM devices/.test(sql)) return [[{ id: 4, snmp_community: 'private-comm' }, { id: 5, snmp_community: 'x'.repeat(120) }]];
        if (/^SELECT/.test(sql)) return [[]];
        return [{ affectedRows: 1 }];
      }),
    };

    const result = await encryptPlaintextCredentials({ db: fake, apply: true });

    expect(result.encrypted).toBe(1);
    expect(result.tooLong).toBe(1);
    const update = fake.query.mock.calls.find(([sql]) => /^UPDATE devices SET snmp_community/.test(sql));
    expect(decrypt(update[1][0])).toBe('private-comm');
    expect(update[1].slice(1)).toEqual([4, 'private-comm']);
  });
});
