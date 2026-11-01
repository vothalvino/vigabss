// =============================================================================
// SEC-19 — API tokens need explicit scopes, revocation is one-way, and
// token_hash is never returned
// =============================================================================
// POST stored NULL scopes (unrestricted) when none were sent; PUT accepted
// {revoked_at: null} (un-revoke) and {scopes: null} (widen to unrestricted);
// list, get and the PUT response carried token_hash.
// =============================================================================

const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  query: (...a) => mockQuery(...a),
  execute: (...a) => mockQuery(...a),
  getConnection: jest.fn(),
  close: jest.fn(),
  withPrimaryContext: (fn) => fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin', organizationId: 1 }; next(); },
  optionalAuth: (_req, _res, next) => next(),
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  enforceTokenScopes: () => {},
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const app = require('../src/app');

const TOKEN = { id: 5, organization_id: 1, user_id: 1, name: 't', token_hash: 'a'.repeat(64), scopes: '["clients:read"]', revoked_at: null };
let revokedAt;
beforeEach(() => {
  revokedAt = null;
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql) => {
    if (/^\s*INSERT INTO/i.test(sql)) return [{ insertId: 5, affectedRows: 1 }];
    if (/UPDATE api_tokens SET revoked_at = NOW\(\)/.test(sql)) { revokedAt = revokedAt || '2026-11-01 10:00:00'; return [{ affectedRows: 1 }]; }
    if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: 1 }];
    if (/COUNT\(\*\)/i.test(sql)) return [[{ total: 1 }]];
    if (/FROM `?api_tokens`?/i.test(sql)) return [[{ ...TOKEN, revoked_at: revokedAt }]];
    return [[]];
  });
});

test('creating a token without scopes is refused; full access is an explicit *:write', async () => {
  const none = await request(app).post('/api/v1/api-tokens').send({ name: 'ci' });
  expect(none.status).toBe(422);
  const empty = await request(app).post('/api/v1/api-tokens').send({ name: 'ci', scopes: [] });
  expect(empty.status).toBe(422);

  const full = await request(app).post('/api/v1/api-tokens').send({ name: 'ci', scopes: ['*:write'] });
  expect(full.status).toBe(201);
  expect(full.body.data.token).toMatch(/^[0-9a-f]{64}$/);
  expect(full.body.data).not.toHaveProperty('token_hash');
});

test('an update cannot widen a token to unrestricted or un-revoke it', async () => {
  const widen = await request(app).put('/api/v1/api-tokens/5').send({ scopes: null });
  expect(widen.status).toBe(422);

  const res = await request(app).put('/api/v1/api-tokens/5').send({ name: 'renamed', revoked_at: null });
  expect(res.status).toBe(200);
  const update = mockQuery.mock.calls.find(([sql]) => /^\s*UPDATE `?api_tokens`?\s+SET/i.test(sql) && !/revoked_at = NOW/.test(sql));
  expect(update[0]).not.toMatch(/revoked_at/);
  expect(res.body.data).not.toHaveProperty('token_hash');
});

test('revocation is a one-way action', async () => {
  const res = await request(app).post('/api/v1/api-tokens/5/revoke');
  expect(res.status).toBe(200);
  expect(res.body.data.revoked_at).toBeTruthy();
  const [sql] = mockQuery.mock.calls.find(([q]) => /revoked_at = NOW\(\)/.test(q));
  expect(sql).toMatch(/AND revoked_at IS NULL/);
});

test('list and get never return token_hash', async () => {
  const list = await request(app).get('/api/v1/api-tokens');
  expect(list.status).toBe(200);
  for (const t of list.body.data) expect(t).not.toHaveProperty('token_hash');
  const one = await request(app).get('/api/v1/api-tokens/5');
  expect(one.body.data).not.toHaveProperty('token_hash');
});
