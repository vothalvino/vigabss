// =============================================================================
// SEC-13 — one request spends one unit of each rate-limit budget
// =============================================================================
// apiLimiter ran at app.use('/api/') and again on several v1 mounts, including
// three routers mounted at '/' that every later path passes through, so one
// request spent up to four units. The tenant bucket (applied by every
// router's orgScope) had the same problem, and it was one bucket for every
// user and token of the organization.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(),
  getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');

const request = require('supertest');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const app = require('../src/app');

// Resolves true when the limiter lets the request through, false when it
// answers (429) instead. The tenant limiter chains two buckets, so next() can
// run after the outer promise settles.
function passes(limiter, req) {
  return new Promise((resolve) => {
    const res = {
      setHeader: () => {}, getHeader: () => undefined, headersSent: false,
      status() { return this; }, json() { resolve(false); return this; }, send() { resolve(false); return this; }, end() { resolve(false); },
    };
    limiter(req, res, (err) => resolve(!err));
  });
}

const remaining = (res) => {
  const raw = res.headers['ratelimit-remaining'] ?? (/remaining=(\d+)/.exec(res.headers.ratelimit || '') || [])[1];
  return Number(raw);
};

beforeEach(() => {
  db.query.mockResolvedValue([[]]);
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
  User.getPermissions.mockResolvedValue([]);
});

// Paths mounted after the three '/' routers pass through all of them.
test.each([
  '/api/v1/regulatory-compliance/obligations',
  '/api/v1/reports/summary',
  '/api/v1/alerts/rules',
  '/api/v1/clients',
])('GET %s lowers the per-IP RateLimit-Remaining by exactly 1', async (path) => {
  const ip = `10.13.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const first = await request(app).get(path).set('X-Forwarded-For', ip);
  const second = await request(app).get(path).set('X-Forwarded-For', ip);
  expect(Number.isFinite(remaining(first))).toBe(true);
  expect(remaining(first) - remaining(second)).toBe(1);
});

test('the tenant limiter counts a request once however many routers apply orgScope', async () => {
  const { tenantApiLimiter } = require('../src/middleware/rateLimit');
  const req = { orgId: 9001, ip: '1.2.3.4', headers: {}, socket: { remoteAddress: '1.2.3.4' }, user: { id: 5 } };
  for (let i = 0; i < 3; i++) expect(await passes(tenantApiLimiter, req)).toBe(true);
  const { CacheStore } = require('../src/middleware/rateLimit');
  const probe = new CacheStore();
  probe.init({ windowMs: config.rateLimit.tenantWindowMs });
  // One more hit on the same key reports 2 if the three passes counted once.
  expect((await probe.increment('tenant:9001')).totalHits).toBe(2);
});

test('one user cannot spend the whole tenant budget', async () => {
  const { tenantApiLimiter } = require('../src/middleware/rateLimit');
  const cap = config.rateLimit.tenantPrincipalApi;
  expect(cap).toBeLessThan(config.rateLimit.tenantApi);
  const mk = (userId) => ({ orgId: 9002, ip: '1.2.3.4', headers: {}, socket: { remoteAddress: '1.2.3.4' }, user: { id: userId } });
  let passed = 0;
  for (let i = 0; i < cap + 5; i++) {
    if (await passes(tenantApiLimiter, mk(7))) passed++;
  }
  expect(passed).toBe(cap);
  expect(await passes(tenantApiLimiter, mk(8))).toBe(true);
});

test('the Helm and k8s defaults match the 1000 per-window config default', () => {
  const fs = require('fs');
  for (const f of ['k8s/configmap.yaml', 'charts/fireisp/values.yaml']) {
    expect(fs.readFileSync(f, 'utf8')).toMatch(/RATE_LIMIT_API: "1000"/);
  }
});
