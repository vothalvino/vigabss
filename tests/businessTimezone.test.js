// =============================================================================
// BIL-34 — business dates are the business time zone's calendar day
// =============================================================================
// Every container and MySQL session runs in UTC, so payment, issue and ledger
// dates (DEFAULT CURRENT_DATE), "overdue" comparisons (CURDATE(), NOW()) and
// JS defaults (toISOString().slice(0, 10)) used the UTC day: in Mexico City a
// payment taken at 19:00 on 31 March was dated 1 April, and cron ran in UTC.
// =============================================================================

const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database', () => ({ query: jest.fn(async () => [{ insertId: 1 }]) }));

const db = require('../src/config/database');
const businessDate = require('../src/utils/businessDate');

const SRC = path.join(__dirname, '..', 'src');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory()
    ? walk(path.join(dir, e.name))
    : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}
const sources = walk(SRC).map(file => ({ file: path.relative(SRC, file), text: fs.readFileSync(file, 'utf8') }));

const savedTz = process.env.BUSINESS_TIMEZONE;
afterEach(() => {
  if (savedTz === undefined) delete process.env.BUSINESS_TIMEZONE; else process.env.BUSINESS_TIMEZONE = savedTz;
  jest.useRealTimers();
});

describe('businessDate', () => {
  test('19:00 on 31 March in Mexico City is still 31 March, though UTC has moved on', () => {
    const evening = new Date('2026-04-01T01:00:00Z');
    expect(businessDate.businessDate(evening)).toBe('2026-03-31');
    expect(evening.toISOString().slice(0, 10)).toBe('2026-04-01');
  });

  test('defaults to America/Mexico_City; BUSINESS_TIMEZONE changes it; an unknown zone falls back', () => {
    delete process.env.BUSINESS_TIMEZONE;
    expect(businessDate.businessTimezone()).toBe('America/Mexico_City');
    process.env.BUSINESS_TIMEZONE = 'Asia/Tokyo';
    expect(businessDate.businessDate(new Date('2026-04-01T16:00:00Z'))).toBe('2026-04-02');
    process.env.BUSINESS_TIMEZONE = 'Not/AZone';
    expect(businessDate.businessTimezone()).toBe('America/Mexico_City');
  });

  test('sqlBusinessToday is a DATE literal of the business day', () => {
    jest.useFakeTimers({ now: new Date('2026-04-01T01:00:00Z') });
    expect(businessDate.sqlBusinessToday()).toBe("DATE('2026-03-31')");
  });

  test('calendar helpers', () => {
    expect(businessDate.addDays('2026-02-27', 2)).toBe('2026-03-01');
    expect(businessDate.startOfMonth('2026-02-27')).toBe('2026-02-01');
    expect(businessDate.endOfMonth('2026-02-10')).toBe('2026-02-28');
  });
});

describe('dates written to the database', () => {
  const DATE_COLUMN = {
    invoices: 'issue_date', payments: 'payment_date', credit_notes: 'issue_date', quotes: 'issue_date', client_balance_ledger: 'entry_date',
  };

  test('every raw INSERT into a table whose date defaults to CURRENT_DATE passes the date', () => {
    const missing = [];
    const insert = /INSERT\s+(?:IGNORE\s+)?INTO\s+`?(invoices|payments|credit_notes|quotes|client_balance_ledger)`?\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/g;
    for (const { file, text } of sources) {
      for (const m of text.matchAll(insert)) {
        const line = text.slice(0, m.index).split('\n').length;
        // The dynamic quote insert fills issue_date before building its columns.
        if (m[2].includes('${')) continue;
        if (!m[2].includes(DATE_COLUMN[m[1]])) missing.push(`${file}:${line} ${m[1]} omits ${DATE_COLUMN[m[1]]}`);
        if (/CURDATE\(\)|CURRENT_DATE/.test(m[3])) missing.push(`${file}:${line} ${m[1]} uses the UTC day`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('Model.create fills an omitted payment date with the business day', async () => {
    jest.useFakeTimers({ now: new Date('2026-04-01T01:00:00Z') });
    const Payment = require('../src/models/Payment');
    db.query.mockResolvedValueOnce([{ insertId: 5 }]).mockResolvedValueOnce([[{ id: 5 }]]);

    await Payment.create({ organization_id: 1, client_id: 2, amount: 100 });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/`payment_date`/);
    expect(params).toContain('2026-03-31');
  });

  test('an explicit date is kept', async () => {
    const Payment = require('../src/models/Payment');
    db.query.mockClear();
    db.query.mockResolvedValueOnce([{ insertId: 6 }]).mockResolvedValueOnce([[{ id: 6 }]]);
    await Payment.create({ organization_id: 1, client_id: 2, amount: 5, payment_date: '2026-01-15' });
    expect(db.query.mock.calls[0][1]).toContain('2026-01-15');
    expect(db.query.mock.calls[0][1]).toHaveLength(4);
  });

  test.each([
    ['Invoice', 'issue_date'], ['Payment', 'payment_date'], ['Quote', 'issue_date'],
    ['CreditNote', 'issue_date'], ['ClientBalanceLedger', 'entry_date'],
  ])('%s declares %s as a business date', (model, column) => {
    expect(require(`../src/models/${model}`).businessDateColumns).toEqual([column]);
  });
});

describe('overdue and dunning use the business day', () => {
  // Analytics windows over snapshot rows the aggregators date in UTC.
  const UTC_SNAPSHOT_WINDOWS = new Set(['services/alertService.js', 'controllers/dashboardController.js', 'routes/snmpMetrics.js']);

  test('no CURDATE() or CURRENT_DATE outside the UTC snapshot windows', () => {
    const found = sources
      .filter(({ file }) => !UTC_SNAPSHOT_WINDOWS.has(file) && !file.startsWith('scripts/'))
      .flatMap(({ file, text }) => text.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /CURDATE\(\)|\bCURRENT_DATE\b/.test(line) && !/^\s*(\/\/|\*)/.test(line))
        .map(({ n }) => `${file}:${n}`));
    expect(found).toEqual([]);
  });

  test('days overdue and "past due" compare against the business day, not NOW()', () => {
    const found = sources.flatMap(({ file, text }) => text.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /DATEDIFF\(NOW\(\),\s*i\.due_date\)|due_date\s*<\s*NOW\(\)/.test(line))
      .map(({ n }) => `${file}:${n}`));
    expect(found).toEqual([]);
  });

  test('the suspension query counts days overdue from the business day', () => {
    jest.useFakeTimers({ now: new Date('2026-04-01T01:00:00Z') });
    const text = sources.find(s => s.file === 'services/suspensionService.js').text;
    expect(text).toMatch(/DATEDIFF\(\$\{sqlBusinessToday\(\)\}, i\.due_date\)/);
  });
});

describe('the scheduler', () => {
  test('cron runs in the business time zone', async () => {
    jest.resetModules();
    jest.doMock('node-cron', () => ({ validate: () => true, schedule: jest.fn(() => ({ stop: jest.fn() })) }));
    jest.doMock('../src/config/database', () => ({
      query: jest.fn(async () => [[{ id: 1, task_name: 'billing_cycle', cron_expression: '0 7 * * *', organization_id: null }]]),
    }));
    process.env.BUSINESS_TIMEZONE = 'America/Monterrey';
    const cron = require('node-cron');
    const scheduler = require('../src/services/scheduler');
    await scheduler.start();
    scheduler.stop();
    expect(cron.schedule).toHaveBeenCalledWith('0 7 * * *', expect.any(Function), { timezone: 'America/Monterrey' });
    jest.dontMock('node-cron');
    jest.dontMock('../src/config/database');
  });
});
