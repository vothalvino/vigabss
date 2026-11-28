// =============================================================================
// The cashier page: one line per person
// =============================================================================
// What a person's drawer holds, and the reasons its dot is red: a count that
// did not match and is not settled, an opening count that differs from the
// last close, a drawer over the pickup limit, a cashier open too long.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/utils/logger', () => {
  const mock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn(() => mock) };
  return mock;
});

const db = require('../src/config/database');
const service = require('../src/services/cashReconciliationService');

/** Answers by what the statement is. `people` is keyed by user id. */
function database({ settings = [], people = {}, users = [], history = [] } = {}) {
  const calls = [];
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    calls.push([text, params]);
    if (/FROM organization_settings/.test(text)) return [settings];
    if (/MAX\(s\.id\) AS last_session_id/.test(text)) {
      const only = /AND s\.agent_user_id = \?/.test(text) ? Number(params[1]) : null;
      return [Object.entries(people).filter(([id]) => only === null || Number(id) === only).map(([id, p]) => ({
        agent_user_id: Number(id), last_session_id: p.last.id, awaiting_review: p.awaiting || 0, disputed: p.disputed || 0,
      }))];
    }
    if (/TIMESTAMPDIFF\(HOUR, s\.opened_at, NOW\(\)\) AS hours_open/.test(text)) {
      return [Object.entries(people).map(([id, p]) => ({ agent_user_id: Number(id), ...p.last })).filter((r) => params.slice(1).includes(r.id))];
    }
    if (/AS collected FROM payments/.test(text)) return [[{ collected: (people[params[1]] || {}).collected || '0.00' }]];
    if (/FROM cash_reconciliation_pickups/.test(text)) {
      const owner = Object.values(people).find((p) => p.last.id === params[1]);
      return [(owner && owner.pickups) || []];
    }
    if (/FROM users WHERE id IN/.test(text)) return [users];
    if (/^SELECT \* FROM cash_reconciliation_sessions/.test(text)) return [history];
    return [[]];
  });
  return { calls, find: (re) => calls.find(([text]) => re.test(text)) };
}

const open = (id, extra = {}) => ({ id, status: 'open', opened_at: '2026-11-27 09:00:00', closed_at: null, opening_total: '500.00', opening_expected: '500.00', counted_total: null, hours_open: 2, ...extra });
const closed = (id, counted, extra = {}) => ({ id, status: 'approved', opened_at: '2026-11-26 09:00:00', closed_at: '2026-11-26 18:00:00', opening_total: '500.00', opening_expected: '500.00', counted_total: counted, hours_open: 30, ...extra });
const USERS = [{ id: 10, first_name: 'Ana', last_name: 'Ruiz' }, { id: 11, first_name: 'Beto', last_name: 'Luna' }, { id: 12, first_name: 'Caro', last_name: 'Paz' }];
const line = (rows, id) => rows.find((r) => r.user_id === id);

describe('staffOverview', () => {
  test('an open cashier shows what the drawer holds now; a closed one what was last counted', async () => {
    database({
      users: USERS,
      people: {
        10: { last: open(7), collected: '1200.00', pickups: [{ status: 'confirmed', n: 1, total: '300.00' }, { status: 'pending', n: 1, total: '50.00' }] },
        11: { last: closed(5, '820.50') },
      },
    });
    const rows = await service.staffOverview(1);
    expect(line(rows, 10)).toMatchObject({
      name: 'Ana Ruiz', open: true, cash_on_hand: 1400, status: 'ok', reasons: [], last_session_id: 7,
      current: { session_id: 7, opening_total: 500, collected_total: 1200, pickups_total: 300, pending_pickups: 1, pending_pickups_total: 50, opening_difference: 0 },
    });
    expect(line(rows, 11)).toMatchObject({ name: 'Beto Luna', open: false, cash_on_hand: 820.5, current: null, status: 'ok', reasons: [], last_closed_at: '2026-11-26 18:00:00' });
  });

  test('red for a count that did not match and waits for a review, or was disputed', async () => {
    database({ users: USERS, people: { 10: { last: closed(5, '400.00', { status: 'closed' }), awaiting: 1 }, 11: { last: open(8), disputed: 1 }, 12: { last: closed(6, '100.00') } } });
    const rows = await service.staffOverview(1);
    expect(line(rows, 10)).toMatchObject({ status: 'mismatch', reasons: ['closing_difference'], awaiting_review: 1 });
    expect(line(rows, 11)).toMatchObject({ status: 'mismatch', reasons: ['closing_difference'], disputed: 1 });
    expect(line(rows, 12)).toMatchObject({ status: 'ok', reasons: [] });
  });

  test('red for an opening count that differs from the last close', async () => {
    database({ users: USERS, people: { 10: { last: open(7, { opening_total: '450.00', opening_expected: '500.00' }) }, 11: { last: open(8, { opening_expected: null }) } } });
    const rows = await service.staffOverview(1);
    expect(line(rows, 10)).toMatchObject({ status: 'mismatch', reasons: ['opening_difference'], current: { opening_difference: -50 } });
    expect(line(rows, 11)).toMatchObject({ status: 'ok' });
  });

  test('red over the cash limit, but only when a limit is set', async () => {
    const people = { 10: { last: open(7), collected: '4500.00' } };
    database({ users: USERS, people });
    expect(line(await service.staffOverview(1), 10).reasons).toEqual([]);
    database({ users: USERS, people, settings: [{ setting_key: 'cashier_pickup_threshold', setting_value: '5000' }] });
    expect(line(await service.staffOverview(1), 10).reasons).toEqual(['over_limit']);
    database({ users: USERS, people: { 10: { last: open(7), collected: '4499.99' } }, settings: [{ setting_key: 'cashier_pickup_threshold', setting_value: '5000' }] });
    expect(line(await service.staffOverview(1), 10).reasons).toEqual([]);
  });

  test('red when open past the allowed hours; every reason is listed, the count first', async () => {
    database({ users: USERS, people: { 10: { last: open(7, { hours_open: 16, opening_total: '0.00' }), awaiting: 2 } } });
    expect(line(await service.staffOverview(1), 10)).toMatchObject({
      status: 'mismatch', reasons: ['closing_difference', 'opening_difference', 'open_too_long'],
    });
  });

  test('what needs a look comes first, then by name', async () => {
    database({ users: USERS, people: { 10: { last: closed(5, '1.00') }, 11: { last: closed(6, '1.00') }, 12: { last: closed(7, '1.00', { status: 'closed' }), awaiting: 1 } } });
    expect((await service.staffOverview(1)).map((r) => r.user_id)).toEqual([12, 10, 11]);
  });

  test('every statement is bound to the organization, and one person narrows it', async () => {
    const q = database({ users: USERS, people: { 10: { last: open(7) }, 11: { last: open(8) } } });
    const rows = await service.staffOverview(4, { onlyUserId: 11 });
    expect(rows.map((r) => r.user_id)).toEqual([11]);
    expect(q.find(/MAX\(s\.id\) AS last_session_id/)[1]).toEqual([4, 11]);
    for (const [text, params] of q.calls.filter(([t]) => /cash_reconciliation_sessions|FROM payments|cash_reconciliation_pickups/.test(t))) {
      expect(text).toMatch(/organization_id = \?/);
      expect(params[0]).toBe(4);
    }
  });

  test('nobody has a cashier: an empty list', async () => {
    database();
    expect(await service.staffOverview(1)).toEqual([]);
  });
});

describe('staffDetail', () => {
  const history = [{ id: 7, agent_user_id: 10, status: 'open', approved_by: null }, { id: 5, agent_user_id: 10, status: 'approved', approved_by: 11 }];

  test('full: every session of the person, with names', async () => {
    const q = database({ users: USERS, people: { 10: { last: open(7) } }, history });
    const out = await service.staffDetail(1, 10, { full: true });
    expect(out.scope).toBe('full');
    expect(out.person).toMatchObject({ user_id: 10, name: 'Ana Ruiz' });
    expect(out.rules).toEqual({ max_open_hours: 16, pickup_threshold: 0, pickup_strict: false });
    expect(out.sessions.map((s) => [s.id, s.agent_name, s.approved_by_name])).toEqual([[7, 'Ana Ruiz', null], [5, 'Ana Ruiz', 'Beto Luna']]);
    const [text, params] = q.find(/^SELECT \* FROM cash_reconciliation_sessions/);
    expect(params).toEqual([1, 10]);
    expect(text).not.toMatch(/status IN/);
  });

  test('not full (a supervisor, or the person themself): only the open cashier and the counts not settled', async () => {
    const q = database({ users: USERS, people: { 10: { last: open(7) } }, history: [history[0]] });
    const out = await service.staffDetail(1, 10);
    expect(out.scope).toBe('supervisor');
    expect(q.find(/^SELECT \* FROM cash_reconciliation_sessions/)[0]).toMatch(/AND status IN \('open', 'closed', 'disputed'\)/);
  });

  test('a person with no cashier in this organization is not found', async () => {
    database({ users: USERS, people: {} });
    await expect(service.staffDetail(1, 99, { full: true })).rejects.toMatchObject({ statusCode: 404 });
  });
});
