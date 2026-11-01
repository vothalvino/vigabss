// =============================================================================
// OPS-01 — /metrics is not public and its series cannot grow without bound
// =============================================================================
// Latency series were keyed by the raw path whenever no route matched, and
// never pruned: requests to random paths grew the map until the process ran
// out of memory. /metrics and /health?detail=true were also open to anyone.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const { httpDuration, MAX_SERIES } = require('../src/routes/metrics');

// The latency histogram's series, as { method, path }.
const series = () => [...httpDuration.series.map.values()].map(({ values: [method, path] }) => ({ method, path }));
const app = require('../src/app');

const ENV = { ...process.env };
afterEach(() => {
  process.env.NODE_ENV = ENV.NODE_ENV;
  if (ENV.METRICS_TOKEN === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = ENV.METRICS_TOKEN;
});
beforeEach(() => {
  httpDuration.reset();
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(sql) ? [[{ total: 0 }]] : [[]]));
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

describe('series', () => {
  test('a thousand unknown paths share one "unmatched" series', async () => {
    for (let i = 0; i < 1000; i++) {
      await request(app).post(`/random-${i}-${'x'.repeat(200)}`);
    }
    const paths = series().map(s => s.path);
    expect(paths).toEqual(['unmatched']);
  });

  test('a matched request is labelled by its full route template', async () => {
    const token = jwt.sign({ sub: 1, email: 'u@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
    await request(app).get('/api/v1/onu-management/profiles/5').set('Authorization', `Bearer ${token}`);
    expect(series().map(s => s.path)).toContain('/api/v1/onu-management/profiles/:id');
  });

  test('past the cap, new series share one overflow series', async () => {
    for (let i = 0; i < MAX_SERIES; i++) httpDuration.observe({ method: 'GET', path: `/prefill/${i}` }, 0.001);
    await request(app).get('/healthz');
    await request(app).post('/nowhere');
    // One overflow series for everything past the cap, nothing else.
    expect(httpDuration.series.map.size).toBe(MAX_SERIES + 1);
    expect(series().filter(s => s.path === '__other__')).toHaveLength(1);
  });

  test('an unknown method does not create its own series', async () => {
    await request(app).search('/whatever');
    expect(series().map(s => s.method)).toEqual(['OTHER']);
  });
});

describe('access', () => {
  test('in production without METRICS_TOKEN, /metrics is 404 and health has no detail', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.METRICS_TOKEN;
    expect((await request(app).get('/metrics')).status).toBe(404);
    const health = await request(app).get('/health?detail=true');
    expect(health.body.memory).toBeUndefined();
    expect(health.body.db).toBeUndefined();
  });

  test('with METRICS_TOKEN, only the matching Bearer token gets through', async () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_TOKEN = 'scrape-secret';
    expect((await request(app).get('/metrics')).status).toBe(404);
    expect((await request(app).get('/metrics').set('Authorization', 'Bearer wrong-secret')).status).toBe(404);
    const ok = await request(app).get('/metrics').set('Authorization', 'Bearer scrape-secret');
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('http_requests_total');
    db.query.mockResolvedValue([[{ 1: 1 }]]);
    const health = await request(app).get('/health?detail=true').set('Authorization', 'Bearer scrape-secret');
    expect(health.body.memory).toBeDefined();
  });
});

test('the shipped nginx configs never proxy /metrics', () => {
  const fs = require('fs');
  for (const file of ['nginx/nginx.conf', 'nginx/host-nginx.conf']) {
    expect(fs.readFileSync(require('path').join(__dirname, '..', file), 'utf8')).toMatch(/location = \/metrics \{\s*return 404;\s*\}/);
  }
});
