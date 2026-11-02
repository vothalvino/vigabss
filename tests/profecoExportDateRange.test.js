// =============================================================================
// REG-13 — the PROFECO export's date_to includes the whole last day
// =============================================================================
// reported_at is DATETIME; `reported_at <= '2026-03-31'` compared against
// 2026-03-31 00:00:00 and dropped every complaint received later that day.

jest.mock('../src/config/database', () => ({ query: jest.fn(), queryReplica: jest.fn(async () => [[]]) }));
const db = require('../src/config/database');
const { buildReport } = require('../src/services/profecoService');

test('date_to is an exclusive next-day bound', async () => {
  await buildReport(3, { dateFrom: '2026-01-01', dateTo: '2026-03-31', format: 'json' });
  const [sql, params] = db.queryReplica.mock.calls[0];
  expect(sql).toMatch(/pc\.reported_at < DATE_ADD\(\?, INTERVAL 1 DAY\)/);
  expect(sql).not.toMatch(/reported_at <= \?/);
  expect(params).toEqual(expect.arrayContaining(['2026-01-01', '2026-03-31']));
});

describe('route validation', () => {
  const express = require('express');
  const request = require('supertest');
  jest.doMock('../src/middleware/auth', () => ({ authenticate: (req, _res, next) => { req.user = { id: 1 }; next(); } }));
  jest.doMock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 3; next(); } }));
  jest.doMock('../src/middleware/orgLocale', () => ({ requireMxLocale: (_req, _res, next) => next() }));
  jest.doMock('../src/middleware/rbac', () => ({ requirePermission: () => (_req, _res, next) => next() }));

  test.each(['2026-02-31', '31/03/2026', '2026-03-31T23:00'])('rejects date_to=%s', async (value) => {
    const app = express();
    app.use('/profeco', require('../src/routes/profeco'));
    app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
    const res = await request(app).get('/profeco/export').query({ date_to: value });
    expect(res.status).toBe(422);
  });
});
