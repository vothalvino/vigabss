// =============================================================================
// TNA-25 (+ TNB-36, ASY-37) — CSV exports neutralize formulas, skip deleted rows
// =============================================================================
// The export, tax-report, scheduled-report and PROFECO CSV writers quoted only
// , " and newlines, so a cell such as =HYPERLINK(...) in a client name ran as
// a formula when billing staff opened the file. The four /export queries also
// returned soft-deleted invoices, clients, contracts and payments.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn(), pool: { end: jest.fn() } }));

const db = require('../src/config/database');
const { csvCell, toCsv } = require('../src/utils/csv');
const exportController = require('../src/controllers/exportController');
const scheduledReportService = require('../src/services/scheduledReportService');
const profecoService = require('../src/services/profecoService');

const res = () => ({ set: jest.fn(), send: jest.fn() });

describe('csvCell', () => {
  test.each(['=HYPERLINK("http://x","y")', '+cmd|calc', '-2+3', '@SUM(A1)', '\t=1', '\r=1', ' =1'])('%j is written as text', (v) => {
    expect(csvCell(v).replace(/^"/, '')).toMatch(/^'/);
  });

  test.each([[-150.5, '-150.5'], ['-150.50', '-150.50'], ['+5215512345678', '+5215512345678'], [0, '0'], ['Ana', 'Ana']])('%j stays as is', (v, out) => {
    expect(csvCell(v)).toBe(out);
  });

  test('quoting still applies after neutralizing', () => {
    expect(csvCell('=a,"b"')).toBe('"\'=a,""b"""');
  });
});

describe('every spreadsheet CSV writer neutralizes formulas', () => {
  const rows = [{ name: '=cmd|calc', total: -10 }];
  test.each([
    ['exportController.toCsv', () => exportController.toCsv(rows)],
    ['scheduledReportService.toCSV', () => scheduledReportService.toCSV(rows)],
    ['profecoService.toCsv', () => profecoService.toCsv(rows)],
    ['utils/csv toCsv', () => toCsv(rows)],
  ])('%s', (_name, run) => {
    expect(run().split('\n')[1]).toBe("'=cmd|calc,-10");
  });

  test('the billing tax report and the CDR export use utils/csv', () => {
    const read = (f) => require('fs').readFileSync(require('path').join(__dirname, '..', 'src', f), 'utf8');
    expect(read('routes/billing.js')).toMatch(/const csv = toCsv\(rows\);/);
    expect(read('services/radiusAccountingService.js')).toMatch(/return csvCell\(row\[col\]\);/);
  });
});

describe('/export', () => {
  beforeEach(() => { jest.clearAllMocks(); db.query.mockResolvedValue([[]]); });

  test.each([
    ['exportInvoices', 'i.deleted_at IS NULL', 'invoices'],
    ['exportClients', 'deleted_at IS NULL', 'clients'],
    ['exportContracts', 'c.deleted_at IS NULL', 'contracts'],
    ['exportPayments', 'p.deleted_at IS NULL', 'payments'],
  ])('%s leaves out soft-deleted rows and records the export', async (fn, clause, entity) => {
    await exportController[fn]({ orgId: 7, query: {}, user: { id: 3 }, ip: '10.0.0.1', get: () => 'jest' }, res(), jest.fn());
    expect(db.query.mock.calls[0][0]).toContain(clause);
    const log = db.query.mock.calls.find(([sql]) => /INSERT INTO report_access_logs/.test(sql));
    expect(log[1]).toEqual(expect.arrayContaining([7, 3, entity]));
  });

  test('?include_deleted=true opts back in', async () => {
    await exportController.exportClients({ orgId: 7, query: { include_deleted: 'true' }, user: { id: 3 } }, res(), jest.fn());
    expect(db.query.mock.calls[0][0]).not.toContain('deleted_at IS NULL');
  });
});
