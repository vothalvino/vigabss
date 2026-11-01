// =============================================================================
// GQL-09 — an API token's configured rate limit applies on every route
// =============================================================================
// PUT /security-admin/api-key-rate-limits/:tokenId stored a policy, but only
// the two collector routes ever consulted it: a throttled token kept using
// /graphql and every other REST route at the IP and organization budgets.
// orgScope now runs the policy for every token request, once per request.

const request = require('supertest');

const mockUser = {
  id: 4,
  role: 'support',
  organizationId: 17,
  apiTokenId: 9,
  scopes: ['*:read'],
  apiTokenRateLimitPolicy: {
    requests_per_minute: 1, requests_per_hour: 100, requests_per_day: 1000, burst_size: 10, is_active: 1,
  },
};

jest.mock('../src/config/database', () => ({
  query: jest.fn(async () => [[]]),
  queryReplica: jest.fn(async () => [[]]),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
  withPrimaryContext: jest.fn(callback => callback()),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { ...mockUser }; req.userId = mockUser.id; next(); },
  optionalAuth: (req, _res, next) => { req.user = { ...mockUser }; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/cacheService', () => {
  const counters = new Map();
  return {
    mockCounters: counters,
    get: jest.fn(async () => null),
    set: jest.fn(async () => true),
    del: jest.fn(async () => true),
    incrementFixedWindow: jest.fn(async (key, windowMs) => {
      const count = (counters.get(key) || 0) + 1;
      counters.set(key, count);
      return { count, resetAt: Date.now() + windowMs };
    }),
    decrementFixedWindow: jest.fn(),
  };
});

const cacheService = require('../src/services/cacheService');
const app = require('../src/app');

const minuteKey = 'rl_api_token_policy:17:9:minute';

beforeEach(() => {
  cacheService.mockCounters.clear();
});

test('a token at its per-minute limit gets 429 from /graphql', async () => {
  const query = { query: '{ __typename }' };
  const first = await request(app).post('/api/v1/graphql').send(query);
  expect(first.status).not.toBe(429);

  const second = await request(app).post('/api/v1/graphql').send(query);
  expect(second.status).toBe(429);
  expect(second.body.error.message).toBe('API token minute rate limit exceeded');
});

test('a token at its per-minute limit gets 429 from a REST route', async () => {
  const first = await request(app).get('/api/v1/clients');
  expect(first.status).not.toBe(429);

  const second = await request(app).get('/api/v1/clients');
  expect(second.status).toBe(429);
});

test('one request is counted once, however many orgScope mounts it passes', async () => {
  await request(app).get('/api/v1/clients');
  expect(cacheService.mockCounters.get(minuteKey)).toBe(1);
});
