// =============================================================================
// REG-07 — session and CDR date filters match sessions active in the window
// =============================================================================
// The session list, the session export and the CDR export filtered on the
// session START. A session that began Sep 25 and ran to Oct 10 was missing from
// an "Oct 1 – Oct 31" export, and an IP search over a window missed the
// long-running session that actually held the address. The binding report
// already used an overlap predicate; these now do too.
// =============================================================================

const request = require('supertest');

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
  withPrimaryContext: (fn) => fn(),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 8, role: 'admin' }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');

// A JS reading of the two predicates, applied to concrete sessions, so the test
// is about which sessions match and not only about SQL text.
function activeIn(session, from, to) {
  const lastSeen = session.last_accounting_at || session.event_at;
  return session.event_at <= to && (session.event_type !== 'stop' || lastSeen >= from);
}

const SESSIONS = {
  startedBeforeRanInto: { event_at: '2026-09-25', event_type: 'stop', last_accounting_at: '2026-10-10' },
  insideWindow: { event_at: '2026-10-05', event_type: 'stop', last_accounting_at: '2026-10-06' },
  endedBefore: { event_at: '2026-09-01', event_type: 'stop', last_accounting_at: '2026-09-20' },
  stillOpen: { event_at: '2026-08-01', event_type: 'interim-update', last_accounting_at: '2026-10-15' },
  startedAfter: { event_at: '2026-11-02', event_type: 'start', last_accounting_at: null },
};

test('the overlap rule keeps sessions that ran into the window', () => {
  const matched = Object.entries(SESSIONS).filter(([, s]) => activeIn(s, '2026-10-01', '2026-10-31')).map(([k]) => k);
  expect(matched).toEqual(['startedBeforeRanInto', 'insideWindow', 'stillOpen']);
});

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(sql) ? [[{ total: 0 }]] : [[]]));
});

const whereOf = (re) => {
  const call = db.query.mock.calls.find(([sql]) => re.test(sql));
  return call;
};

test('GET /connection-logs filters by overlap, not by start', async () => {
  const app = require('../src/app');
  const res = await request(app).get('/api/v1/connection-logs')
    .query({ date_from: '2026-10-01T00:00:00Z', date_to: '2026-10-31T23:59:59Z' });
  expect(res.status).toBe(200);
  const [sql, params] = whereOf(/FROM connection_logs cl/);
  expect(sql).toMatch(/\(cl\.event_type <> 'stop' OR COALESCE\(cl\.last_accounting_at, cl\.event_at\) >= \?\)/);
  expect(sql).toMatch(/cl\.event_at <= \?/);
  expect(sql).not.toMatch(/cl\.event_at >= \?/);
  expect(params).toEqual(expect.arrayContaining([1]));
});

test('the CDR export filters by overlap, not by start', async () => {
  const { exportCdr } = require('../src/services/radiusAccountingService');
  await exportCdr({ from: '2026-10-01', to: '2026-10-31', organizationId: 1 });
  const [sql, params] = whereOf(/SELECT COUNT\(\*\) AS total FROM connection_logs cl/);
  expect(sql).toMatch(/cl\.event_at < DATE_ADD\(\?, INTERVAL 1 DAY\)/);
  expect(sql).toMatch(/\(cl\.event_type <> 'stop' OR COALESCE\(cl\.last_accounting_at, cl\.event_at\) >= \?\)/);
  expect(sql).not.toMatch(/cl\.event_at >= \?/);
  expect(params.slice(0, 3)).toEqual(['2026-10-31', '2026-10-01', 1]);
});
