// =============================================================================
// ASY-14 — scheduled reports go only to staff, are audited, and stop with
// their creator
// =============================================================================
// recipients was stored from the request body unchecked, so any reports.schedule
// holder could have subscriber-identity or regulatory exports (names, emails,
// IPs) mailed hourly to an outside address. Nothing re-checked the creator,
// so a schedule kept running after its creator left, and deliveries were not
// written to report_access_logs.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/services/reportService', () => ({ subscriberIdentity: jest.fn() }));
jest.mock('../src/services/emailTransport', () => ({ sendEmail: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 8, role: 'billing', organizationId: 1 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const db = require('../src/config/database');
const User = require('../src/models/User');
const reportService = require('../src/services/reportService');
const emailTransport = require('../src/services/emailTransport');
const { runSchedule } = require('../src/services/scheduledReportService');

let creator;
beforeEach(() => {
  jest.clearAllMocks();
  creator = { id: 8, status: 'active' };
  jest.spyOn(User, 'getUsersWithPermission').mockResolvedValue([
    { id: 8, email: 'ops@isp.mx' }, { id: 9, email: 'cfo@isp.mx' },
  ]);
  jest.spyOn(User, 'hasEffectivePermission').mockResolvedValue(true);
  reportService.subscriberIdentity.mockResolvedValue({ rows: [{ name: 'Ana', ip: '203.0.113.7' }] });
  db.query.mockImplementation(async (sql) => {
    if (/FROM users WHERE id = \?/.test(sql)) return [creator ? [creator] : []];
    if (/INSERT INTO generated_reports/.test(sql)) return [{ insertId: 70 }];
    return [{ insertId: 1, affectedRows: 1 }];
  });
  db.queryReplica.mockResolvedValue([[{ id: 5 }]]);
});

const SCHEDULE = {
  id: 5, organization_id: 1, report_def_name: 'subscriber-identity', format: 'csv',
  cron_expression: '0 8 * * 1', parameters: {}, recipients: ['ops@isp.mx', 'old-staff@isp.mx'], created_by: 8,
};

describe('saving a schedule', () => {
  const app = require('../src/app');

  test('an outside address is refused', async () => {
    const res = await request(app).post('/api/v1/scheduled-reports')
      .send({ report_def_name: 'subscriber-identity', recipients: ['ops@isp.mx', 'me@gmail.com'] });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/me@gmail\.com/);
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO scheduled_reports/.test(sql))).toBe(false);
    expect(User.getUsersWithPermission).toHaveBeenCalledWith(1, 'reports.view');
  });

  test('a recipients value that is not a list of emails is refused', async () => {
    for (const recipients of ['["ops@isp.mx"]', [42], ['not-an-email']]) {
      const res = await request(app).put('/api/v1/scheduled-reports/5').send({ recipients });
      expect(res.status).toBe(422);
    }
  });

  test('staff addresses are stored normalized', async () => {
    const res = await request(app).post('/api/v1/scheduled-reports')
      .send({ report_def_name: 'aging', recipients: [' OPS@isp.mx', 'cfo@isp.mx', 'ops@isp.mx'] });
    expect(res.status).toBe(201);
    const [, params] = db.query.mock.calls.find(([sql]) => /INSERT INTO scheduled_reports/.test(sql));
    expect(params[5]).toBe(JSON.stringify(['ops@isp.mx', 'cfo@isp.mx']));
  });
});

describe('sending a schedule', () => {
  test('recipients who are no longer staff are dropped, and each delivery is audited', async () => {
    await runSchedule(SCHEDULE);
    expect(emailTransport.sendEmail.mock.calls.map(([m]) => m.to)).toEqual(['ops@isp.mx']);
    const logs = db.query.mock.calls.filter(([sql]) => /INSERT INTO report_access_logs/.test(sql));
    expect(logs).toHaveLength(1);
    const [, params] = logs[0];
    expect(params.slice(0, 4)).toEqual([1, 8, 'subscriber-identity', 5]);
    expect(JSON.parse(params[4])).toMatchObject({ recipient: 'ops@isp.mx', generated_report_id: 70, created_by: 8 });
  });

  test.each([
    ['is archived', () => { creator = null; }],
    ['is inactive', () => { creator = { id: 8, status: 'inactive' }; }],
    ['lost reports.schedule', () => { User.hasEffectivePermission.mockResolvedValue(false); }],
  ])('a schedule whose creator %s is disabled without sending', async (_label, arrange) => {
    arrange();
    const result = await runSchedule(SCHEDULE);
    expect(result.disabled).toBe(true);
    expect(reportService.subscriberIdentity).not.toHaveBeenCalled();
    expect(emailTransport.sendEmail).not.toHaveBeenCalled();
    const [sql] = db.query.mock.calls.find(([q]) => /UPDATE scheduled_reports/.test(q));
    expect(sql).toMatch(/is_enabled = 0/);
  });
});
