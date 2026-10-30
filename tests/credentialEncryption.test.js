// =============================================================================
// BIL-08 / BIL-09 — gateway and PAC credentials are encrypted at rest
// =============================================================================
// The settings routes stored whatever the client sent in the *_encrypted
// columns, so they held plaintext even with ENCRYPTION_KEY set, and an edit
// that sent an empty secret wiped the stored one. Credentials now arrive in
// write-only plaintext fields that only the route seals into the columns.
// =============================================================================

const TEST_KEY = 'a'.repeat(64);
process.env.ENCRYPTION_KEY = TEST_KEY;

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/PaymentGateway');
jest.mock('../src/models/PacProvider');
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/utils/safeOutboundUrl', () => ({ assertSafeOutboundUrl: jest.fn(async url => url) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const PaymentGateway = require('../src/models/PaymentGateway');
const db = require('../src/config/database');
const PacProvider = require('../src/models/PacProvider');
const User = require('../src/models/User');
const { encrypt, decrypt } = require('../src/utils/encryption');
const { encryptPlaintextCredentials } = require('../src/scripts/encrypt-plaintext-credentials');
const app = require('../src/app');

const adminToken = jwt.sign(
  { sub: 1, email: 'admin@test.com', role: 'admin', orgId: 1 },
  config.jwt.secret,
  { expiresIn: '1h' },
);
const gatewayRow = { id: 5, organization_id: 1, name: 'Stripe', provider: 'stripe', secret_key_encrypted: 'x', webhook_secret_encrypted: null, status: 'active' };
const pacRow = { id: 9, organization_id: 1, provider_name: 'sw_sapien', label: 'SW', api_url: 'https://services.test.sw.com.mx', status: 'active' };

const send = (method, path, body) => request(app)[method](path)
  .set('Authorization', `Bearer ${adminToken}`).set('X-Org-Id', '1').send(body);

afterAll(() => { delete process.env.ENCRYPTION_KEY; });

beforeEach(() => {
  jest.clearAllMocks();
  // requireMxLocale (PAC routes) needs an MX-locale organization.
  db.query.mockResolvedValue([[{ locale: 'MX' }]]);
  User.findById.mockResolvedValue({ id: 1, email: 'admin@test.com', status: 'active', role: 'admin', organization_id: 1 });
  PaymentGateway.create.mockResolvedValue(gatewayRow);
  PaymentGateway.update.mockResolvedValue(gatewayRow);
  PaymentGateway.findByIdOrFail.mockResolvedValue(gatewayRow);
  PaymentGateway.findById.mockResolvedValue(gatewayRow);
  PacProvider.create.mockResolvedValue(pacRow);
  PacProvider.update.mockResolvedValue(pacRow);
  PacProvider.findByIdOrFail.mockResolvedValue(pacRow);
  PacProvider.findById.mockResolvedValue(pacRow);
});

describe('payment gateways', () => {
  test('create stores the secrets as ciphertext, never as the plaintext sent', async () => {
    const res = await send('post', '/api/v1/payment-gateways', {
      name: 'Stripe MX', provider: 'stripe', secret_key: 'sk_live_1', webhook_secret: 'whsec_1',
    });

    expect(res.status).toBe(201);
    const stored = PaymentGateway.create.mock.calls[0][0];
    expect(stored.secret_key_encrypted).not.toBe('sk_live_1');
    expect(stored.secret_key_encrypted.split(':')).toHaveLength(3);
    expect(decrypt(stored.secret_key_encrypted)).toBe('sk_live_1');
    expect(decrypt(stored.webhook_secret_encrypted)).toBe('whsec_1');
  });

  test('a create without a secret (manual gateway) stores an empty secret, not NULL', async () => {
    const res = await send('post', '/api/v1/payment-gateways', { name: 'Cash', provider: 'manual' });

    expect(res.status).toBe(201);
    expect(PaymentGateway.create.mock.calls[0][0].secret_key_encrypted).toBe('');
  });

  test.each(['secret_key_encrypted', 'webhook_secret_encrypted'])(
    'a client cannot write %s directly (it was stored verbatim)', async (column) => {
      const res = await send('post', '/api/v1/payment-gateways', { name: 'X', provider: 'stripe', [column]: 'plain' });

      expect(res.status).toBe(422);
      expect(PaymentGateway.create).not.toHaveBeenCalled();
    },
  );

  test('an edit with a blank secret keeps the stored secret', async () => {
    const res = await send('put', '/api/v1/payment-gateways/5', { name: 'Renamed', secret_key: '', webhook_secret: '' });

    expect(res.status).toBe(200);
    const update = PaymentGateway.update.mock.calls[0][1];
    expect(update.name).toBe('Renamed');
    expect(update).not.toHaveProperty('secret_key_encrypted');
    expect(update).not.toHaveProperty('webhook_secret_encrypted');
    expect(update).not.toHaveProperty('secret_key');
  });

  test('an edit that sets the webhook secret saves it encrypted', async () => {
    const res = await send('put', '/api/v1/payment-gateways/5', { webhook_secret: 'whsec_new' });

    expect(res.status).toBe(200);
    expect(decrypt(PaymentGateway.update.mock.calls[0][1].webhook_secret_encrypted)).toBe('whsec_new');
  });
});

describe('PAC providers', () => {
  test('create and edit store PAC credentials as ciphertext', async () => {
    const res = await send('post', '/api/v1/pac-providers', {
      provider_name: 'sw_sapien', label: 'SW', api_url: 'https://services.test.sw.com.mx',
      username: 'user@isp.mx', password: 'pw', token: 'T0KEN',
    });
    expect(res.status).toBe(201);
    const stored = PacProvider.create.mock.calls[0][0];
    for (const [col, plain] of [['username_encrypted', 'user@isp.mx'], ['password_encrypted', 'pw'], ['token_encrypted', 'T0KEN']]) {
      expect(stored[col]).not.toBe(plain);
      expect(decrypt(stored[col])).toBe(plain);
    }

    const edit = await send('put', '/api/v1/pac-providers/9', { label: 'SW 2', password: '' });
    expect(edit.status).toBe(200);
    expect(PacProvider.update.mock.calls[0][1]).not.toHaveProperty('password_encrypted');
  });

  test('a client cannot write token_encrypted directly', async () => {
    const res = await send('post', '/api/v1/pac-providers', {
      provider_name: 'sw_sapien', label: 'SW', api_url: 'https://services.test.sw.com.mx', token_encrypted: 'plain',
    });
    expect(res.status).toBe(422);
    expect(PacProvider.create).not.toHaveBeenCalled();
  });

  test('SW Sapien auth decrypts the stored token (and still accepts a legacy plaintext one)', async () => {
    const cfdiService = require('../src/services/cfdiService');
    await expect(cfdiService.swAuthToken({ token_encrypted: encrypt('T0KEN') }, 'https://x')).resolves.toBe('T0KEN');
    await expect(cfdiService.swAuthToken({ token_encrypted: 'LEGACY_PLAIN' }, 'https://x')).resolves.toBe('LEGACY_PLAIN');
  });
});

describe('sealSecret in production', () => {
  test('refuses to store a credential when ENCRYPTION_KEY is missing', () => {
    jest.isolateModules(() => {
      const saved = process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;
      jest.doMock('../src/config', () => ({ ...jest.requireActual('../src/config'), env: 'production' }));
      try {
        const { sealSecret } = require('../src/utils/sealSecrets');
        expect(() => sealSecret('sk_live_1')).toThrow(expect.objectContaining({ code: 'ENCRYPTION_NOT_CONFIGURED' }));
      } finally {
        process.env.ENCRYPTION_KEY = saved;
        jest.dontMock('../src/config');
      }
    });
  });
});

describe('encrypt-plaintext-credentials backfill', () => {
  function fakeDb(tables) {
    const writes = [];
    return {
      writes,
      query: jest.fn(async (sql, params) => {
        const select = sql.match(/^SELECT id, (.+) FROM (\w+)$/);
        if (select) return [tables[select[2]] || []];
        const update = sql.match(/^UPDATE (\w+) SET (\w+) = \? WHERE id = \? AND \2 = \?$/);
        const row = (tables[update[1]] || []).find(r => r.id === params[1]);
        if (!row || row[update[2]] !== params[2]) return [{ affectedRows: 0 }];
        row[update[2]] = params[0];
        writes.push({ table: update[1], column: update[2], id: params[1] });
        return [{ affectedRows: 1 }];
      }),
    };
  }

  test('encrypts only plaintext values, is a dry run by default, and is safe to rerun', async () => {
    const already = encrypt('sk_already');
    const db = fakeDb({
      payment_gateways: [{ id: 1, secret_key_encrypted: 'sk_plain', webhook_secret_encrypted: already }],
      pac_providers: [{ id: 2, username_encrypted: 'user', password_encrypted: null, api_key_encrypted: '', token_encrypted: 'tok' }],
    });

    const dry = await encryptPlaintextCredentials({ db });
    expect(dry.found).toBe(3);
    expect(db.writes).toHaveLength(0);

    const applied = await encryptPlaintextCredentials({ db, apply: true });
    expect(applied.encrypted).toBe(3);
    expect(db.writes.map(w => `${w.table}.${w.column}`).sort()).toEqual([
      'pac_providers.token_encrypted', 'pac_providers.username_encrypted', 'payment_gateways.secret_key_encrypted',
    ]);

    const again = await encryptPlaintextCredentials({ db, apply: true });
    expect(again.found).toBe(0);
  });
});
