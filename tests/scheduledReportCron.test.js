// =============================================================================
// ASY-13 — scheduled reports run on their cron_expression, not every hour
// =============================================================================
// cron_expression was stored and never read: every schedule got next_run_at =
// NOW() + 1 hour at creation and after each run, and generate_scheduled_reports
// runs hourly, so a weekly report was generated (and, with DB-05 fixed,
// mailed) 24 times a day. A failed run did not move next_run_at at all.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/services/reportService', () => ({ agingReport: jest.fn() }));
jest.mock('../src/services/emailTransport', () => ({ sendEmail: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 8, role: 'admin', organizationId: 1 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const db = require('../src/config/database');
const reportService = require('../src/services/reportService');
const service = require('../src/services/scheduledReportService');

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue([{ insertId: 9, affectedRows: 1 }]);
  db.queryReplica.mockResolvedValue([[{ id: 9 }]]);
});

describe('nextRunAt', () => {
  const from = new Date(2026, 10, 4, 12, 0, 0); // Wednesday 4 Nov 2026, 12:00 local

  test('a weekly schedule fires next Monday at 08:00', () => {
    const next = service.nextRunAt('0 8 * * 1', from);
    expect([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()])
      .toEqual([2026, 10, 9, 8, 0]);
  });

  test('a monthly schedule fires on the 1st of next month', () => {
    const next = service.nextRunAt('30 6 1 * *', from);
    expect([next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()]).toEqual([11, 1, 6, 30]);
  });

  test('invalid expressions are refused', () => {
    for (const bad of ['', 'every monday', '0 8 * *', '61 8 * * 1', '0 8 * * 1 2026']) {
      expect(() => service.assertValidCron(bad)).toThrow(/cron_expression/);
    }
    expect(() => service.assertValidCron('0 8 * * 1')).not.toThrow();
  });
});

const updateOf = () => db.query.mock.calls.find(([sql]) => /UPDATE scheduled_reports/.test(sql));

test('a completed weekly run is next due in days, not an hour', async () => {
  reportService.agingReport.mockResolvedValue({ rows: [] });
  const before = Date.now();
  await service.runSchedule({
    id: 1, organization_id: 1, report_def_name: 'aging', format: 'csv',
    cron_expression: '0 8 * * 1', parameters: null, recipients: [],
  });
  const [sql, params] = updateOf();
  expect(sql).not.toMatch(/INTERVAL 1 HOUR/);
  const next = params[0];
  expect(next).toBeInstanceOf(Date);
  expect(next.getDay()).toBe(1);
  expect(next.getHours()).toBe(8);
  expect(next.getTime()).toBeGreaterThan(before);
  expect(next.getTime() - before).toBeLessThanOrEqual(7 * 24 * HOUR);
});

test('a failed run also waits for its next slot', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/FROM scheduled_reports sr/.test(sql)) {
      return [[{ id: 2, organization_id: 1, report_def_name: 'nope', format: 'csv', cron_expression: '30 6 1 * *' }]];
    }
    return [{ affectedRows: 1 }];
  });
  const result = await service.processScheduledReports();
  expect(result.failed).toBe(1);
  const [sql, params] = updateOf();
  expect(sql).toMatch(/last_status = 'failed', next_run_at = \?/);
  expect(params[0].getDate()).toBe(1);
});

describe('/scheduled-reports', () => {
  const app = require('../src/app');

  test('POST computes next_run_at from cron_expression', async () => {
    const res = await request(app).post('/api/v1/scheduled-reports')
      .send({ report_def_name: 'aging', cron_expression: '30 6 1 * *', recipients: [] });
    expect(res.status).toBe(201);
    const [sql, params] = db.query.mock.calls.find(([q]) => /INSERT INTO scheduled_reports/.test(q));
    expect(sql).not.toMatch(/INTERVAL 1 HOUR/);
    expect(params[params.length - 1].getDate()).toBe(1);
  });

  test('POST and PUT refuse an invalid cron_expression', async () => {
    const post = await request(app).post('/api/v1/scheduled-reports')
      .send({ report_def_name: 'aging', cron_expression: 'every monday' });
    expect(post.status).toBe(422);
    const put = await request(app).put('/api/v1/scheduled-reports/9').send({ cron_expression: '0 25 * * *' });
    expect(put.status).toBe(422);
    expect(db.query.mock.calls.some(([q]) => /INSERT INTO scheduled_reports|UPDATE scheduled_reports/.test(q))).toBe(false);
  });

  test('PUT with a new cron_expression reschedules from now', async () => {
    const res = await request(app).put('/api/v1/scheduled-reports/9').send({ cron_expression: '0 8 * * 1' });
    expect(res.status).toBe(200);
    const [sql, params] = updateOf();
    expect(sql).toMatch(/next_run_at = COALESCE\(\?, next_run_at\)/);
    expect(params[4]).toBeInstanceOf(Date);
    expect(params[4].getDay()).toBe(1);
  });
});
