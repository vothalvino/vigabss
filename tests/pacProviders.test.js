// =============================================================================
// VigaBSS 5.0 — PAC Provider Route Tests
// =============================================================================
// Regression coverage for the secret-redaction fix (same vulnerability class
// as src/routes/paymentGateways.js): username_encrypted, password_encrypted,
// api_key_encrypted and token_encrypted hold ciphertext at rest — but
// src/utils/encryption.js's encrypt()/decrypt() are transparent no-ops when
// ENCRYPTION_KEY is unset, so these columns can hold PLAINTEXT PAC account
// credentials. GET/POST/PUT must never return any of them verbatim.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('../src/models/PacProvider');
// The outbound-address check resolves the host for real; these tests are
// about what is stored, so the lookup is skipped (it has its own tests) and a
// DNS hiccup cannot fail them.
jest.mock('../src/utils/safeOutboundUrl', () => ({
  ...jest.requireActual('../src/utils/safeOutboundUrl'),
  assertSafeOutboundUrl: jest.fn(async url => url),
}));
jest.mock('../src/models/User');

const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const PacProvider = require('../src/models/PacProvider');
const User = require('../src/models/User');
const { decrypt } = require('../src/utils/encryption');
const app = require('../src/app');

function makeToken(payload = {}) {
  return jwt.sign(
    { sub: 1, email: 'admin@test.com', role: 'admin', orgId: 1, ...payload },
    config.jwt.secret,
    { expiresIn: '1h' },
  );
}

const adminToken = makeToken();

function mockAdminUser() {
  User.findById.mockResolvedValue({
    id: 1,
    email: 'admin@test.com',
    status: 'active',
    role: 'admin',
    organization_id: 1,
  });
  // requireMxLocale (mounted ahead of the CRUD routes) needs an MX-locale org.
  db.query.mockResolvedValue([[{ locale: 'MX' }]]);
}

const rawProviderRow = {
  id: 4,
  organization_id: 1,
  provider_name: 'finkok',
  label: 'Finkok Producción',
  environment: 'production',
  username_encrypted: 'PLAINTEXT_USERNAME',
  password_encrypted: 'PLAINTEXT_PASSWORD',
  api_key_encrypted: 'PLAINTEXT_API_KEY',
  token_encrypted: 'PLAINTEXT_TOKEN',
  api_url: 'https://facturacion.finkok.com',
  is_default: 1,
  status: 'active',
};

function assertRedacted(body) {
  ['username_encrypted', 'password_encrypted', 'api_key_encrypted', 'token_encrypted'].forEach((f) => {
    expect(body).not.toHaveProperty(f);
  });
  expect(JSON.stringify(body)).not.toContain('PLAINTEXT');
}

describe('PAC Provider routes — secret redaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminUser();
  });

  test('GET /api/v1/pac-providers (list) never leaks credentials', async () => {
    PacProvider.findAll.mockResolvedValue([rawProviderRow]);
    PacProvider.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/v1/pac-providers')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Org-Id', '1');

    expect(res.status).toBe(200);
    assertRedacted(res.body.data[0]);
    expect(res.body.data[0]).toMatchObject({
      has_username: true,
      has_password: true,
      has_api_key: true,
      has_token: true,
    });
    expect(res.body.data[0].provider_name).toBe('finkok');
  });

  test('GET /api/v1/pac-providers/:id never leaks credentials', async () => {
    PacProvider.findByIdOrFail.mockResolvedValue(rawProviderRow);

    const res = await request(app)
      .get('/api/v1/pac-providers/4')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Org-Id', '1');

    expect(res.status).toBe(200);
    assertRedacted(res.body.data);
  });

  test('has_* booleans are false for unset credential columns', async () => {
    PacProvider.findByIdOrFail.mockResolvedValue({
      ...rawProviderRow,
      api_key_encrypted: null,
      token_encrypted: null,
    });

    const res = await request(app)
      .get('/api/v1/pac-providers/4')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Org-Id', '1');

    expect(res.body.data.has_api_key).toBe(false);
    expect(res.body.data.has_token).toBe(false);
    expect(res.body.data.has_username).toBe(true);
    expect(res.body.data.has_password).toBe(true);
  });

  test('POST /api/v1/pac-providers never leaks credentials in the 201 response', async () => {
    PacProvider.create.mockResolvedValue(rawProviderRow);

    const res = await request(app)
      .post('/api/v1/pac-providers')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Org-Id', '1')
      .send({
        provider_name: 'finkok',
        label: 'Finkok prueba',
        api_url: 'https://demo-facturacion.finkok.com',
        // Write-only plaintext fields (BIL-08), sealed by the route.
        username: 'PLAINTEXT_USERNAME',
        password: 'PLAINTEXT_PASSWORD',
      });

    expect(res.status).toBe(201);
    assertRedacted(res.body.data);
    const stored = PacProvider.create.mock.calls[0][0];
    expect(decrypt(stored.username_encrypted)).toBe('PLAINTEXT_USERNAME');
    expect(decrypt(stored.password_encrypted)).toBe('PLAINTEXT_PASSWORD');
    expect(stored).not.toHaveProperty('username');
    expect(stored).not.toHaveProperty('password');
  });
});

// ===========================================================================
// Active fiscal environment switch (GET/PUT /pac-providers/environment)
// ===========================================================================
describe('PAC fiscal environment follows the install switch', () => {
  const originalMode = config.install.mode;
  beforeEach(() => {
    jest.clearAllMocks();
    User.findById.mockResolvedValue({ id: 1, email: 'admin@test.com', status: 'active', role: 'admin', organization_id: 1 });
    db.query.mockImplementation(async (sql) => {
      if (/SELECT locale FROM organizations/i.test(sql)) return [[{ locale: 'MX' }]];
      if (/COUNT\(\*\) AS n FROM cfdi_documents/.test(sql)) return [[{ n: 0 }]];
      return [[]];
    });
  });
  afterEach(() => { config.install.mode = originalMode; });
  const call = (method, path) => request(app)[method](path)
    .set('Authorization', `Bearer ${adminToken}`).set('X-Org-Id', '1');

  test('GET reports production on a live install and sandbox on a test install', async () => {
    let res = await call('get', '/api/v1/pac-providers/environment');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ pac_environment: 'production', sandbox_vigente_count: 0 });

    config.install.mode = 'test';
    res = await call('get', '/api/v1/pac-providers/environment');
    expect(res.body.data).toMatchObject({ pac_environment: 'sandbox' });
    // The organization's fiscal profile is not consulted.
    expect(db.query.mock.calls.some(([sql]) => /pac_environment FROM organization_mx_profiles/i.test(sql))).toBe(false);
  });

  test('the environment can no longer be set', async () => {
    const res = await call('put', '/api/v1/pac-providers/environment').send({ pac_environment: 'sandbox' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FISCAL_ENVIRONMENT_FIXED');
    expect(db.query.mock.calls.find(c => /UPDATE organization_mx_profiles/i.test(c[0]))).toBeFalsy();
  });

  const NEW_PAC = { provider_name: 'sw_sapien', label: 'SW', api_url: 'https://services.sw.com.mx', token: 'example-token' };

  test('a new PAC gets the install\'s environment, whatever the request says', async () => {
    PacProvider.create.mockImplementation(async data => ({ id: 1, ...data }));
    let res = await call('post', '/api/v1/pac-providers').send({ ...NEW_PAC, environment: 'sandbox' });
    expect(res.status).toBe(201);
    expect(PacProvider.create.mock.calls[0][0].environment).toBe('production');

    config.install.mode = 'test';
    res = await call('post', '/api/v1/pac-providers').send({ ...NEW_PAC, environment: 'production' });
    expect(PacProvider.create.mock.calls[1][0].environment).toBe('sandbox');
  });

  test('an edit cannot move a PAC to the other environment', async () => {
    PacProvider.findByIdOrFail.mockResolvedValue({ id: 5, organization_id: 1, environment: 'production' });
    PacProvider.update.mockImplementation(async (_id, data) => ({ id: 5, ...data }));
    const res = await call('put', '/api/v1/pac-providers/5').send({ label: 'Renamed', environment: 'sandbox' });
    expect(res.status).toBe(200);
    expect(PacProvider.update.mock.calls[0][1]).not.toHaveProperty('environment');
  });

  test('the simulator exists only on a test install', async () => {
    PacProvider.create.mockImplementation(async data => ({ id: 1, ...data }));
    const simulator = { provider_name: 'simulator', label: 'Simulator', api_url: 'https://simulator.invalid' };
    let res = await call('post', '/api/v1/pac-providers').send(simulator);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAC_SIMULATOR_TEST_ONLY');
    expect(PacProvider.create).not.toHaveBeenCalled();

    config.install.mode = 'test';
    res = await call('post', '/api/v1/pac-providers').send(simulator);
    expect(res.status).toBe(201);
  });
});
