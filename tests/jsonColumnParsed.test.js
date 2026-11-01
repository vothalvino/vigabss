// =============================================================================
// DB-05 — JSON columns arrive decoded from mysql2 and are not parsed again
// =============================================================================
// scheduled_reports.recipients/parameters and automation_rules
// .trigger_conditions/action_config are JSON columns, which mysql2 returns as
// objects and arrays. JSON.parse on them threw (an array of addresses becomes
// "a@b.c", not JSON), so every UI-created schedule failed before mailing and
// no automation rule with conditions ever ran.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/reportService', () => ({ agingReport: jest.fn() }));
jest.mock('../src/services/emailTransport', () => ({ sendEmail: jest.fn().mockResolvedValue({ success: true }) }));

const db = require('../src/config/database');
const reportService = require('../src/services/reportService');
const emailTransport = require('../src/services/emailTransport');
const { parseJsonColumn } = require('../src/utils/jsonColumn');

beforeEach(() => jest.clearAllMocks());

test('parseJsonColumn accepts decoded values and JSON text', () => {
  expect(parseJsonColumn(['a@b.c'])).toEqual(['a@b.c']);
  expect(parseJsonColumn('["a@b.c"]')).toEqual(['a@b.c']);
  expect(parseJsonColumn({ from: '2026-10-01' })).toEqual({ from: '2026-10-01' });
  expect(parseJsonColumn(Buffer.from('{"x":1}'))).toEqual({ x: 1 });
  expect(parseJsonColumn(null, [])).toEqual([]);
});

test('a schedule read from MySQL (decoded recipients and parameters) is mailed', async () => {
  const { runSchedule } = require('../src/services/scheduledReportService');
  reportService.agingReport.mockResolvedValue({ rows: [{ client: 'Ana', total: 10 }] });
  db.query.mockResolvedValue([{ insertId: 5, affectedRows: 1 }]);
  await runSchedule({
    id: 1, organization_id: 1, report_def_name: 'aging', format: 'csv', cron_expression: '0 8 * * 1',
    parameters: { as_of: '2026-10-31' },
    recipients: ['ops@example.com', 'cfo@example.com'],
  });
  expect(reportService.agingReport).toHaveBeenCalledWith(1, { as_of: '2026-10-31' });
  expect(emailTransport.sendEmail.mock.calls.map(([m]) => m.to)).toEqual(['ops@example.com', 'cfo@example.com']);
});

test('an automation rule with decoded conditions and config is evaluated', async () => {
  const automationService = require('../src/services/automationService');
  const rule = {
    id: 3, organization_id: 1, action_type: 'set_alert', trigger_event: 'payment.received',
    trigger_conditions: [{ field: 'amount', operator: 'gte', value: 100 }],
    action_config: { severity: 'info' },
  };
  db.query.mockImplementation(async (sql) => (/FROM automation_rules/.test(sql) ? [[rule]] : [{ affectedRows: 1 }]));
  await automationService.evaluateAutomationRules(1, 'payment.received', { amount: 150 });
  const [, params] = db.query.mock.calls.find(([sql]) => /INSERT INTO automation_rule_executions/.test(sql));
  expect(params[4]).not.toBe('failure');
  expect(db.query.mock.calls.some(([sql]) => /SET run_count = run_count \+ 1/.test(sql))).toBe(true);
});

test('the automation-rule API takes trigger_conditions as an array', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'automationRules.js'), 'utf8');
  expect(src.match(/trigger_conditions: \{ type: 'array' \}/g)).toHaveLength(2);
});
