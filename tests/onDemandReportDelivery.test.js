// =============================================================================
// ASY-24 — on-demand reports reach the requester
// =============================================================================
// runOnDemand generated and formatted the report, then threw the file away and
// marked the generated_reports row 'completed'. Nothing stores generated files,
// so the requester now receives the report by email; the row is 'completed'
// only once it was sent, with its size, and the delivery is audited.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/services/reportService', () => ({ agingReport: jest.fn() }));
jest.mock('../src/services/emailTransport', () => ({ sendEmail: jest.fn() }));

const db = require('../src/config/database');
const reportService = require('../src/services/reportService');
const emailTransport = require('../src/services/emailTransport');
const { runOnDemand } = require('../src/services/scheduledReportService');

let requester;
beforeEach(() => {
  jest.clearAllMocks();
  requester = { email: 'ops@isp.mx' };
  reportService.agingReport.mockResolvedValue({ rows: [{ client: 'Ana', balance: 120 }] });
  emailTransport.sendEmail.mockResolvedValue({ success: true });
  db.query.mockImplementation(async (sql) => {
    if (/INSERT INTO generated_reports/.test(sql)) return [{ insertId: 70 }];
    if (/FROM users WHERE id = \?/.test(sql)) return [requester ? [requester] : []];
    return [{ affectedRows: 1 }];
  });
});

const run = () => runOnDemand({ organizationId: 1, reportDefName: 'aging', format: 'csv', generatedBy: 8 });
const statusUpdate = () => db.query.mock.calls.find(([sql]) => /UPDATE generated_reports SET status/.test(sql));

test('the formatted file is emailed to the requester before the row is completed', async () => {
  await expect(run()).resolves.toEqual({ reportId: 70, status: 'completed' });

  expect(emailTransport.sendEmail).toHaveBeenCalledTimes(1);
  const mail = emailTransport.sendEmail.mock.calls[0][0];
  expect(mail).toMatchObject({ organizationId: 1, operationalRecipient: true, to: 'ops@isp.mx' });
  expect(mail.attachments[0].content.toString()).toContain('Ana');

  const [sql, params] = statusUpdate();
  expect(sql).toMatch(/status = 'completed', file_size = \?/);
  expect(params).toEqual([mail.attachments[0].content.length, 70]);
  const audit = db.query.mock.calls.find(([q]) => /INSERT INTO report_access_logs/.test(q));
  expect(audit[1]).toEqual(expect.arrayContaining([1, 8, 'aging', 70]));
});

test('a failed send marks the row failed instead of completed', async () => {
  emailTransport.sendEmail.mockResolvedValue({ success: false, error: 'SMTP down' });
  await expect(run()).rejects.toThrow(/not sent/);
  expect(statusUpdate()[0]).toMatch(/status = 'failed'/);
});

test('a requester without an active email gets a failed row, and no report is generated', async () => {
  requester = null;
  await expect(run()).rejects.toThrow(/email address/);
  expect(reportService.agingReport).not.toHaveBeenCalled();
  expect(emailTransport.sendEmail).not.toHaveBeenCalled();
  expect(statusUpdate()[0]).toMatch(/status = 'failed'/);
});
