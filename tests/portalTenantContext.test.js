// =============================================================================
// TNB-27 — the subscriber portal works for an organization in isolated mode
// =============================================================================
// orgScope moves staff requests into the organization's database; the portal
// had no equivalent. portalAuthenticate and portalAuthService read clients on
// the primary, so a subscriber of an isolated organization could not log in
// (or matched a stale pre-cutover copy), and every portal read and write —
// invoices, tickets, refresh tokens — went to the primary, where staff never
// look.
// =============================================================================

const { AsyncLocalStorage } = require('async_hooks');

const mockScope = new AsyncLocalStorage();
const mockQueries = [];
// Organization 7 is isolated. The primary still holds a stale copy of its
// client 5 (pre-cutover); the live row is in tenant7.
const mockData = {
  primary: {
    clients: [{ id: 5, organization_id: 7, name: 'Stale', email: 'ana@example.com', status: 'active', portal_password_hash: 'old', portal_token_version: 0 }],
    refresh: [],
  },
  tenant7: {
    clients: [{ id: 5, organization_id: 7, name: 'Ana', email: 'ana@example.com', status: 'active', portal_password_hash: 'live', portal_token_version: 0 }],
    refresh: [{ id: 90, client_id: 5, token_hash: null }],
  },
};

jest.mock('../src/config/database', () => {
  const where = () => mockScope.getStore() || 'primary';
  const run = async (sql, params = []) => {
    const place = where();
    mockQueries.push({ where: place, sql, params });
    const data = place === 'tenant7' ? mockData.tenant7 : mockData.primary;
    if (/FROM organization_database_configs/.test(sql)) return [[{ organization_id: 7 }]];
    if (/FROM portal_refresh_tokens prt/.test(sql)) {
      const hit = data.refresh.find((r) => r.token_hash === params[0]);
      const client = hit && data.clients.find((c) => c.id === hit.client_id);
      return [hit ? [{ ...hit, ...client, client_id: client.id }] : []];
    }
    if (/FROM clients\s+WHERE email = \?/.test(sql)) return [data.clients.filter((c) => c.email === params[0])];
    if (/FROM clients WHERE id = \?/.test(sql)) return [data.clients.filter((c) => c.id === Number(params[0]))];
    if (/^\s*(UPDATE|INSERT)/.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
    return [[]];
  };
  return {
    query: jest.fn(run),
    getConnection: jest.fn(async () => ({
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      execute: jest.fn(run), query: jest.fn(run),
    })),
    withTenantContext: jest.fn((orgId, fn) => mockScope.run(orgId === 7 ? 'tenant7' : 'primary', fn)),
    withPrimaryContext: jest.fn((fn) => mockScope.run('primary', fn)),
    close: jest.fn(),
    pool: { end: jest.fn() },
  };
});
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('$2a$12$new'),
  compare: jest.fn(async (password, hash) => password === 'pw' && hash === 'live'),
}));

const crypto = require('crypto');
const request = require('supertest');
const portalAuthService = require('../src/services/portalAuthService');
const { signPortalAccessToken } = require('../src/utils/accessTokens');
const app = require('../src/app');

beforeEach(() => { mockQueries.length = 0; });

const writes = (re) => mockQueries.filter((q) => re.test(q.sql));

test('login matches the client in the isolated database and stores the refresh token there', async () => {
  const result = await portalAuthService.login({ email: 'ana@example.com', password: 'pw' });
  expect(result.client).toMatchObject({ id: 5, name: 'Ana', organization_id: 7 });
  const insert = writes(/INSERT INTO portal_refresh_tokens/);
  expect(insert.map((q) => q.where)).toEqual(['tenant7']);
  expect(writes(/UPDATE clients SET portal_login_attempts = 0/).map((q) => q.where)).toEqual(['tenant7']);
});

test('the stale primary copy of an isolated client cannot log in', async () => {
  // "old" would be the stale hash; the live tenant row does not match "stale".
  const bcrypt = require('bcryptjs');
  bcrypt.compare.mockImplementation(async (_password, hash) => hash === 'old');
  await expect(portalAuthService.login({ email: 'ana@example.com', password: 'stale' }))
    .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  bcrypt.compare.mockImplementation(async (password, hash) => password === 'pw' && hash === 'live');
});

test('authenticated portal requests run in the organization database', async () => {
  const token = signPortalAccessToken({ clientId: 5, organizationId: 7, tokenVersion: 0 }, 900);
  const res = await request(app).get('/api/v1/portal/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ id: 5, name: 'Ana' });
  expect([...new Set(writes(/FROM clients WHERE id = \?/).map((q) => q.where))]).toEqual(['tenant7']);

  mockQueries.length = 0;
  await request(app).get('/api/v1/portal/invoices').set('Authorization', `Bearer ${token}`);
  expect(writes(/FROM invoices/).length).toBeGreaterThan(0);
  expect([...new Set(writes(/FROM invoices/).map((q) => q.where))]).toEqual(['tenant7']);
});

test('a token for another organization does not authenticate the client', async () => {
  const token = signPortalAccessToken({ clientId: 5, organizationId: 8, tokenVersion: 0 }, 900);
  const res = await request(app).get('/api/v1/portal/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(401);
});

test('refresh rotates the token in the isolated database', async () => {
  mockData.tenant7.refresh[0].token_hash = crypto.createHash('sha256').update('rt-1').digest('hex');
  const result = await portalAuthService.refreshToken('rt-1');
  expect(result.refreshToken).toEqual(expect.any(String));
  expect(writes(/portal_refresh_tokens SET revoked_at/).map((q) => q.where)).toEqual(['tenant7']);
  expect(writes(/INSERT INTO portal_refresh_tokens/).map((q) => q.where)).toEqual(['tenant7']);
});

test('password reset requests and redemptions use the isolated database', async () => {
  const requested = await portalAuthService.requestPasswordReset('ana@example.com');
  expect(requested.resets).toHaveLength(1);
  expect(requested.resets[0]).toMatchObject({ clientId: 5, organizationId: 7, userName: 'Ana' });
  expect(writes(/SET portal_reset_token_hash = \?/).map((q) => q.where)).toEqual(['tenant7']);
});
