// =============================================================================
// WHK-11 — payment webhooks are processed in the owning organization's database
// =============================================================================
// The webhook router had no tenant context, so every query used the primary
// database: an isolated organization's gateway was never found (or a primary
// gateway with the same id answered), its transactions never matched, and on
// the install-wide route a missed reference fell back to
// `SELECT … WHERE id = metadata.transaction_id` — possibly another tenant's.
// =============================================================================

const { AsyncLocalStorage } = require('async_hooks');

const mockScope = new AsyncLocalStorage();
// Two databases: org 7 is isolated; gateway 3 exists in both (a stale primary copy).
const mockData = {
  primary: { gateways: [{ id: 3, organization_id: 7, provider: 'stripe', webhook_secret_encrypted: null }], isolated: [7] },
  tenant7: { gateways: [{ id: 3, organization_id: 7, provider: 'stripe', webhook_secret_encrypted: null }] },
};
const mockQueries = [];

jest.mock('../src/config/database', () => ({
  query: jest.fn(async (sql, params = []) => {
    const where = mockScope.getStore() || 'primary';
    mockQueries.push({ where, sql, params });
    const dbData = where === 'tenant7' ? mockData.tenant7 : mockData.primary;
    if (/FROM organization_database_configs/.test(sql)) return [mockData.primary.isolated.includes(Number(params[0])) ? [{ 1: 1 }] : []];
    if (/FROM payment_gateways/.test(sql)) {
      return [dbData.gateways.filter(g => g.id === Number(params[0]) && g.provider === params[1]
        && (params.length < 3 || g.organization_id === Number(params[2])))];
    }
    if (/^SELECT id, status FROM webhook_events/.test(sql)) return [[]];
    if (/INSERT INTO webhook_events/.test(sql)) return [{ insertId: 1 }];
    if (/FROM payment_transactions/.test(sql)) return [[]];
    return [{ affectedRows: 1 }];
  }),
  getConnection: jest.fn(),
  withTenantContext: jest.fn((organizationId, fn) => mockScope.run(organizationId === 7 ? 'tenant7' : 'primary', fn)),
  withPrimaryContext: jest.fn(fn => mockScope.run('primary', fn)),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

const request = require('supertest');
const app = require('../src/app');

beforeEach(() => {
  mockQueries.length = 0;
  process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';
});
afterEach(() => { delete process.env.ALLOW_UNSIGNED_WEBHOOKS; });

const event = metadata => ({
  id: 'evt_1', type: 'checkout.session.completed',
  data: { object: { id: 'cs_1', payment_status: 'paid', metadata } },
});

test('the organization-scoped URL loads the gateway and matches transactions in the tenant database', async () => {
  const res = await request(app).post('/api/v1/payment-webhooks/stripe/7/3').send(event({ transaction_id: '201' }));
  expect(res.status).not.toBe(404);
  const gatewayLookup = mockQueries.find(q => /FROM payment_gateways/.test(q.sql));
  expect(gatewayLookup.where).toBe('tenant7');
  expect(gatewayLookup.sql).toMatch(/AND organization_id = \?/);
  const txLookups = mockQueries.filter(q => /FROM payment_transactions/.test(q.sql));
  expect(txLookups.length).toBeGreaterThan(0);
  expect(txLookups.every(q => q.where === 'tenant7')).toBe(true);
});

test("a gateway id under another organization's URL is not found", async () => {
  const res = await request(app).post('/api/v1/payment-webhooks/stripe/8/3').send(event({}));
  expect(res.status).toBe(404);
});

test("the legacy URL refuses an isolated organization's (stale primary) gateway", async () => {
  const res = await request(app).post('/api/v1/payment-webhooks/stripe/3').send(event({}));
  expect(res.status).toBe(404);
  expect(mockQueries.some(q => /FROM payment_transactions/.test(q.sql))).toBe(false);
});

test('the install-wide URL processes in the organization named by the signed metadata', async () => {
  await request(app).post('/api/v1/payment-webhooks/stripe').send(event({ transaction_id: '201', organization_id: '7' }));
  const txLookups = mockQueries.filter(q => /FROM payment_transactions/.test(q.sql));
  expect(txLookups.length).toBeGreaterThan(0);
  expect(txLookups.every(q => q.where === 'tenant7' && q.params.includes(7))).toBe(true);
});

test('the install-wide URL without an organization never looks a transaction up by id alone', async () => {
  await request(app).post('/api/v1/payment-webhooks/stripe').send(event({ transaction_id: '201' }));
  expect(mockQueries.some(q => /FROM payment_transactions WHERE id = \?/.test(q.sql))).toBe(false);
});
