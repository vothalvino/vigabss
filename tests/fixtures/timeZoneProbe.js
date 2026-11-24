// Run in a child process with TZ set (tests/dateMathTimeZones.test.js): prints
// what the date code produces, so the same output can be demanded in every
// time zone. The clock is fixed and the database is a recorder.
const path = require('path');
const root = path.join(__dirname, '..', '..');

const NOW = Date.parse(process.env.PROBE_NOW);
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
global.Date = FixedDate;

const calls = [];
const answers = JSON.parse(process.env.PROBE_ANSWERS || '[]').map((rows) => rows.map((row) => Object.fromEntries(
  Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new RealDate(v) : v]),
)));
const db = {
  query: async (sql, params) => { calls.push({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 60), params }); return [answers.shift() ?? { insertId: 9 }]; },
  getConnection: async () => { throw new Error('no connection in the probe'); },
};
require.cache[require.resolve(path.join(root, 'src/config/database'))] = { id: 'db', filename: 'db', loaded: true, exports: db };

const calendar = require(path.join(root, 'src/utils/calendarDate'));
const billing = require(path.join(root, 'src/services/billingService'));
const plans = require(path.join(root, 'src/services/paymentPlanService'));
const reminders = require(path.join(root, 'src/services/paymentReminderService'));

(async () => {
  const contract = { id: 1, billing_day: 5, start_date: new RealDate('2026-01-02T00:00:00Z'), first_activated_at: new RealDate(process.env.PROBE_ACTIVATED) };
  await billing.generateBillingPeriod(contract);
  const insert = calls.find((c) => /^INSERT INTO billing_periods/.test(c.sql));
  const out = {
    period: insert ? insert.params.slice(1).map((d) => d.toISOString()) : null,
    trial: billing.isContractInTrial ? billing.isContractInTrial(contract, { trial_days: 14 }) : undefined,
    proration: billing.calculateProration({ oldPrice: 300, newPrice: 600, changeDate: '2026-03-16', periodStart: '2026-03-01', periodEnd: '2026-03-31' }),
    weekly: plans.computeDueDates(3, 'weekly'),
    monthly: plans.computeDueDates(3, 'monthly'),
    dueToday: reminders.computeStagesToSend(calendar.ymd(), { days_before_due: [7, 3, 1], send_on_due: 1, days_after_due: [1, 3, 7] }),
    dueInThree: reminders.computeStagesToSend(calendar.ymd(calendar.addDays(new Date(), 3)), { days_before_due: [7, 3, 1], send_on_due: 1, days_after_due: [1, 3, 7] }),
    overdueByOne: reminders.computeStagesToSend(calendar.ymd(calendar.addDays(new Date(), -1)), { days_before_due: [7, 3, 1], send_on_due: 1, days_after_due: [1, 3, 7] }),
    firstOfMonth: calendar.firstOfMonth(),
    previousMonth: [calendar.firstOfMonth(undefined, -1), calendar.lastOfMonth(undefined, -1)],
    lastOfMonth: calendar.lastOfMonth(),
    today: calendar.ymd(calendar.utcDay()),
    due: calendar.ymd(calendar.addDays(new Date(), 15)),
  };
  process.stdout.write(`\n@@PROBE@@${JSON.stringify(out)}@@END@@\n`);
  process.exit(0);
})().catch((err) => { process.stderr.write(String(err && err.stack || err)); process.exit(1); });
