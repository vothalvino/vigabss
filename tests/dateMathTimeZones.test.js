// Billing and usage date arithmetic must not depend on the time zone of the
// machine the application runs on. Each case runs the real code in a child
// process whose TZ is set, with the clock fixed, and demands the same answer
// in every zone: the one a UTC process gives.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const calendar = require('../src/utils/calendarDate');

const PROBE = path.join(__dirname, 'fixtures', 'timeZoneProbe.js');
// West of UTC, far east of it (UTC+14), a half-hour zone, and one with DST.
const ZONES = ['UTC', 'America/Mexico_City', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata', 'Europe/Madrid'];

function probe(zone, { now, activated }) {
  const out = execFileSync(process.execPath, [PROBE], {
    env: { ...process.env, TZ: zone, NODE_ENV: 'test', LOG_LEVEL: 'silent', PROBE_NOW: now, PROBE_ACTIVATED: activated, PROBE_ANSWERS: '[[],[]]' },
    encoding: 'utf8',
  });
  return JSON.parse(/@@PROBE@@(.*)@@END@@/s.exec(out)[1]);
}

describe('the same dates in every time zone', () => {
  // 03:30 UTC on 1 March: still 28 February in the Americas, already 1 March
  // (17:30) at UTC+14. Service was activated at 23:30 UTC on 20 January:
  // the 20th in UTC and the Americas, the 21st in Asia and the Pacific.
  const at = { now: '2026-03-01T03:30:00Z', activated: '2026-01-20T23:30:00Z' };
  const utc = probe('UTC', at);

  test('a UTC process gives the expected calendar dates', () => {
    expect(utc).toEqual({
      period: ['2026-01-20T00:00:00.000Z', '2026-02-19T00:00:00.000Z', '2026-01-05T00:00:00.000Z'],
      trial: false,
      proration: { credit: 154.84, charge: 309.68, net: 154.84, daysRemaining: 16, totalDays: 31 },
      weekly: ['2026-03-02', '2026-03-09', '2026-03-16'],
      monthly: ['2026-03-02', '2026-04-02', '2026-05-02'],
      dueToday: ['before_7', 'before_3', 'before_1', 'on_due'],
      dueInThree: ['before_7', 'before_3'],
      overdueByOne: ['before_7', 'before_3', 'before_1', 'after_1'],
      firstOfMonth: '2026-03-01',
      previousMonth: ['2026-02-01', '2026-02-28'],
      lastOfMonth: '2026-03-31',
      today: '2026-03-01',
      due: '2026-03-16',
    });
  });

  test.each(ZONES.slice(1))('%s gives exactly what UTC gives', (zone) => {
    expect(probe(zone, at)).toEqual(utc);
  });

  test('also on the night clocks change, and at a year end', () => {
    // 29 March 2026 01:30 UTC: Europe/Madrid moves its clocks at 01:00 UTC.
    const dst = { now: '2026-03-29T01:30:00Z', activated: '2026-03-28T23:59:00Z' };
    const base = probe('UTC', dst);
    expect(base.period).toEqual(['2026-03-28T00:00:00.000Z', '2026-04-27T00:00:00.000Z', '2026-03-05T00:00:00.000Z']);
    for (const zone of ['Europe/Madrid', 'America/Mexico_City', 'Pacific/Kiritimati']) expect(probe(zone, dst)).toEqual(base);

    const newYear = { now: '2027-01-01T02:00:00Z', activated: '2026-12-31T22:00:00Z' };
    const first = probe('UTC', newYear);
    expect([first.firstOfMonth, first.previousMonth, first.today]).toEqual(['2027-01-01', ['2026-12-01', '2026-12-31'], '2027-01-01']);
    for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati']) expect(probe(zone, newYear)).toEqual(first);
  }, 60000);
});

describe('calendarDate', () => {
  const d = (iso) => new Date(iso);

  test('utcDay is the start of the UTC day', () => {
    expect(calendar.utcDay('2026-01-20T23:59:59Z').toISOString()).toBe('2026-01-20T00:00:00.000Z');
    expect(calendar.utcDay('2026-01-21').toISOString()).toBe('2026-01-21T00:00:00.000Z');
  });

  test('days and months move without touching the input', () => {
    const start = d('2026-01-31T00:00:00Z');
    expect(calendar.addDays(start, 1).toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(calendar.addDays(start, -31).toISOString()).toBe('2025-12-31T00:00:00.000Z');
    expect(calendar.addMonths(d('2026-01-15T00:00:00Z'), 1).toISOString()).toBe('2026-02-15T00:00:00.000Z');
    expect(calendar.addMonths(d('2026-12-01T00:00:00Z'), 1).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    // JavaScript's own overflow, as before: there is no 31 February.
    expect(calendar.addMonths(start, 1).toISOString()).toBe('2026-03-03T00:00:00.000Z');
    expect(start.toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  test('a billing period is one month, ending the day before the next begins', () => {
    const end = (iso) => calendar.ymd(calendar.addDays(calendar.addMonths(d(iso), 1), -1));
    expect(end('2026-01-01')).toBe('2026-01-31');
    expect(end('2026-02-01')).toBe('2026-02-28');
    expect(end('2028-02-01')).toBe('2028-02-29');
    expect(end('2026-01-20')).toBe('2026-02-19');
  });

  test('month boundaries and month counts', () => {
    expect(calendar.firstOfMonth(d('2026-03-31T23:59:59Z'))).toBe('2026-03-01');
    expect(calendar.firstOfMonth(d('2026-01-10'), -1)).toBe('2025-12-01');
    expect(calendar.lastOfMonth(d('2028-02-10'))).toBe('2028-02-29');
    expect(calendar.lastOfMonth(d('2026-01-10'), -1)).toBe('2025-12-31');
    expect(calendar.onDayOfMonth(d('2026-01-20'), 5).toISOString()).toBe('2026-01-05T00:00:00.000Z');
    expect(calendar.monthsBetween('2025-11-30', '2026-02-01')).toBe(3);
    expect(calendar.monthsBetween('2026-02-01', '2025-11-30')).toBe(-3);
  });
});

describe('no code does calendar arithmetic in the machine\'s time zone', () => {
  // The reviewed exceptions, each with why local time is right or harmless.
  const ALLOWED = {
    'src/services/speedWindowService.js': 'speed windows are times of day on the wall clock',
    'src/services/pppoeEventCollector.js': 'router log lines carry the router\'s own local time',
    'src/services/cfdiService.js': 'lastDayOfMonth(year, month) counts the days of a month, the same in any zone',
  };
  const LOCAL = /\.(get|set)(Date|Month|FullYear|Hours|Minutes|Day)\(|new Date\(\s*[a-zA-Z_$][\w$.]*\s*,/;

  function files(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files(full, out);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  test('only the reviewed files use local-time date methods', () => {
    const root = path.join(__dirname, '..');
    const found = files(path.join(root, 'src'))
      .filter((file) => fs.readFileSync(file, 'utf8').split('\n').some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && LOCAL.test(line) && !/Date\.UTC\(/.test(line)))
      .map((file) => path.relative(root, file).split(path.sep).join('/'))
      .sort();
    expect(found).toEqual(Object.keys(ALLOWED).sort());
  });
});
