// =============================================================================
// VigaBSS 5.0 — Cash Reconciliation Service Unit Tests
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('../src/utils/logger', () => {
  const mock = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => mock),
  };
  return mock;
});

const db = require('../src/config/database');
const cashReconciliationService = require('../src/services/cashReconciliationService');

describe('cashReconciliationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Answers a test queued and did not use must not reach the next test.
    db.query.mockReset();
    // closeSession runs on one transaction; its statements go through the
    // same db.query mock so the sequences below answer them in order.
    db.getConnection.mockResolvedValue({
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      query: (...args) => db.query(...args),
    });
  });

  // Answers by what the statement is, not by the order it arrives in.
  // `state` holds what the database would: the session, sums, settings.
  function database(state = {}) {
    const calls = [];
    db.query.mockImplementation(async (sql, params) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      calls.push([text, params]);
      if (/^SELECT setting_key, setting_value FROM organization_settings/.test(text)) return [state.settings || []];
      if (/^INSERT INTO organization_settings/.test(text)) return [{ affectedRows: 1 }];
      if (/^SELECT id FROM cash_reconciliation_sessions WHERE organization_id = \? AND agent_user_id = \? AND status = 'open'/.test(text)) return [state.alreadyOpen || []];
      if (/^SELECT counted_total FROM cash_reconciliation_sessions/.test(text)) return [state.lastClose === undefined ? [] : [{ counted_total: state.lastClose }]];
      if (/^INSERT INTO cash_reconciliation_sessions/.test(text)) return [{ insertId: 1 }];
      if (/^INSERT INTO cash_reconciliation_session_payments/.test(text)) return [{ affectedRows: 2 }];
      if (/FROM cash_reconciliation_session_payments WHERE session_id = \?/.test(text)) return [[{ expected_total: state.collected ?? '0.00' }]];
      if (/^SELECT COALESCE\(SUM\(amount\), 0\) AS collected FROM payments/.test(text)) return [[{ collected: state.collected ?? '0.00' }]];
      if (/^SELECT status, COUNT\(\*\) AS n, COALESCE\(SUM\(amount\), 0\) AS total FROM cash_reconciliation_pickups/.test(text)) return [state.pickups || []];
      if (/^INSERT INTO cash_reconciliation_pickups/.test(text)) return [{ insertId: 9 }];
      if (/^UPDATE cash_reconciliation_pickups/.test(text)) return [{ affectedRows: 1 }];
      if (/^SELECT \* FROM cash_reconciliation_pickups WHERE id = \?/.test(text)) return [state.pickup ? [state.pickup] : []];
      if (/^UPDATE cash_reconciliation_sessions/.test(text)) return [{ affectedRows: 1 }];
      if (/FROM cash_reconciliation_sessions s WHERE s\.organization_id = \? AND s\.status = 'open'/.test(text)) return [state.openSessions || []];
      if (/^SELECT COUNT\(\*\) AS n FROM cash_reconciliation_sessions/.test(text)) return [[{ n: state.awaiting ?? 0 }]];
      if (/FROM users WHERE id IN/.test(text)) return [state.users || []];
      if (/FROM cash_reconciliation_sessions/.test(text)) return [state.session ? [state.session] : []];
      return [[]];
    });
    return {
      calls,
      find: (re) => calls.find(([text]) => re.test(text)),
    };
  }

  const openSession = {
    id: 1, organization_id: 1, agent_user_id: 10,
    opened_at: new Date(Date.now() - 3600000).toISOString(),
    status: 'open', opening_total: '500.00', opening_expected: '500.00',
  };

  // ===========================================================================
  // openSession
  // ===========================================================================
  describe('openSession', () => {
    test('throws ValidationError when agent already has an open session', async () => {
      const q = database({ alreadyOpen: [{ id: 5 }] });
      await expect(
        cashReconciliationService.openSession({ organizationId: 1, agentUserId: 10, notes: null, openingTotal: 0 }),
      ).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
      expect(q.find(/^INSERT INTO cash_reconciliation_sessions/)).toBeUndefined();
    });

    test('opens with the cash counted and what the drawer should have held: the last close', async () => {
      const q = database({ lastClose: '480.00', session: { ...openSession } });
      const result = await cashReconciliationService.openSession({ organizationId: 1, agentUserId: 10, notes: 'turno', openingTotal: 480 });
      const [sql, params] = q.find(/^INSERT INTO cash_reconciliation_sessions/);
      expect(sql).toMatch(/\(organization_id, agent_user_id, opened_at, status, notes, opening_total, opening_expected\)/);
      expect(params).toEqual([1, 10, 'turno', 480, 480]);
      expect(result).toMatchObject({ id: 1, status: 'open' });
      // The last close of this person in this organization, counted and from the new model only.
      const [carrySql, carryParams] = q.find(/^SELECT counted_total FROM cash_reconciliation_sessions/);
      expect(carryParams).toEqual([1, 10]);
      expect(carrySql).toMatch(/opening_total IS NOT NULL/);
      expect(carrySql).toMatch(/ORDER BY id DESC LIMIT 1/);
    });

    test('a first cashier has nothing to compare its opening count with', async () => {
      const q = database({ session: { ...openSession } });
      await cashReconciliationService.openSession({ organizationId: 1, agentUserId: 10, notes: null, openingTotal: 250.5 });
      expect(q.find(/^INSERT INTO cash_reconciliation_sessions/)[1]).toEqual([1, 10, null, 250.5, null]);
    });

    test('the opening count is required and cannot be negative', async () => {
      for (const openingTotal of [undefined, -1, 'abc']) {
        const q = database();
        await expect(
          cashReconciliationService.openSession({ organizationId: 1, agentUserId: 10, notes: null, openingTotal }),
        ).rejects.toMatchObject({ statusCode: 422 });
        expect(q.find(/^INSERT INTO cash_reconciliation_sessions/)).toBeUndefined();
      }
    });
  });

  // ===========================================================================
  // closeSession
  // ===========================================================================
  describe('closeSession', () => {
    const closeUpdate = (q) => q.find(/^UPDATE cash_reconciliation_sessions SET expected_total/);
    const close = async (state, counted) => {
      const q = database({ session: { ...openSession }, ...state });
      await cashReconciliationService.closeSession(1, 1, counted);
      const [sql, params] = closeUpdate(q);
      const [expected, countedTotal, variance, pickupsTotal, status] = params;
      return { q, sql, expected, countedTotal, variance, pickupsTotal, status };
    };

    test('the drawer should hold the opening count plus the cash taken: closing is a count, not a hand-in', async () => {
      const out = await close({ collected: '200.00' }, 700);
      expect(out).toMatchObject({ expected: 700, countedTotal: 700, variance: 0, pickupsTotal: 0, status: 'approved' });
      expect(out.sql).toMatch(/approved_at = NOW\(\), approved_by = NULL/);
    });

    test('cash a supervisor picked up, and the owner confirmed, is no longer expected in the drawer', async () => {
      const out = await close({ collected: '5200.00', pickups: [{ status: 'confirmed', n: 2, total: '5000.00' }] }, 700);
      expect(out).toMatchObject({ expected: 700, variance: 0, pickupsTotal: 5000, status: 'approved' });
    });

    test('a pickup still waiting for the owner stops the close', async () => {
      const q = database({ session: { ...openSession }, collected: '5200.00', pickups: [{ status: 'pending', n: 1, total: '5000.00' }] });
      await expect(cashReconciliationService.closeSession(1, 1, 700)).rejects.toMatchObject({ statusCode: 422 });
      expect(closeUpdate(q)).toBeUndefined();
    });

    test('a count over or under what the drawer should hold waits for a supervisor', async () => {
      expect(await close({ collected: '300.00' }, 850)).toMatchObject({ expected: 800, variance: 50, status: 'closed' });
      const short = await close({ collected: '500.00' }, 975);
      expect(short).toMatchObject({ expected: 1000, variance: -25, status: 'closed' });
      expect(short.sql).toMatch(/approved_at = NULL/);
    });

    test('a difference within the organization\'s tolerance still counts as a match; a larger one does not', async () => {
      const settings = [{ setting_key: 'cashier_match_tolerance', setting_value: '5' }];
      const status = async (counted) => (await close({ collected: '100.00', settings }, counted)).status;
      expect(await status(597)).toBe('approved');    // 3 short of 600
      expect(await status(605)).toBe('approved');    // exactly 5 over
      expect(await status(605.01)).toBe('closed');   // a cent past it
      expect(await status(594)).toBe('closed');      // 6 short
    });

    test('a stored tolerance the settings would refuse today is ignored', async () => {
      const out = await close({ collected: '100.00', settings: [{ setting_key: 'cashier_match_tolerance', setting_value: 'lots' }] }, 599);
      expect(out.status).toBe('closed');
    });

    test('a cashier opened with a different amount than it was closed with is not approved on its own', async () => {
      const q = database({ session: { ...openSession, opening_total: '300.00', opening_expected: '500.00' }, collected: '200.00' });
      await cashReconciliationService.closeSession(1, 1, 500);
      const [, params] = closeUpdate(q);
      // The shift itself matched (300 + 200 = 500), but 200 went missing before it began.
      expect(params.slice(0, 5)).toEqual([500, 500, 0, 0, 'closed']);
    });

    test('a session from before the cash stayed in the drawer has no opening count: it expects its payments alone', async () => {
      const q = database({ session: { ...openSession, opening_total: null, opening_expected: null }, collected: '200.00' });
      await cashReconciliationService.closeSession(1, 1, 200);
      expect(closeUpdate(q)[1].slice(0, 5)).toEqual([200, 200, 0, 0, 'approved']);
    });

    test('throws NOT_FOUND when session not found', async () => {
      database();
      await expect(cashReconciliationService.closeSession(999, 1, 100)).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });

    test('throws ValidationError when session is not open, and freezes nothing', async () => {
      const conn = {
        beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
        query: (...args) => db.query(...args),
      };
      db.getConnection.mockResolvedValueOnce(conn);
      const q = database({ session: { ...openSession, status: 'closed' } });
      await expect(cashReconciliationService.closeSession(1, 1, 100)).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
      expect(conn.rollback).toHaveBeenCalled();
      expect(conn.commit).not.toHaveBeenCalled();
      expect(q.find(/^INSERT INTO cash_reconciliation_session_payments/)).toBeUndefined();
    });

    // The total and the list a closed session shows come from one frozen set:
    // the payments are copied first and the cash taken is their sum.
    test('freezes the window\'s payments and sums what it froze', async () => {
      const { q } = await close({ collected: '200.00' }, 700);
      const lock = q.calls[0];
      const freeze = q.find(/^INSERT INTO cash_reconciliation_session_payments/);
      const sum = q.find(/FROM cash_reconciliation_session_payments WHERE session_id = \?/);
      expect(lock[0]).toMatch(/FOR UPDATE/);
      expect(freeze[0]).toMatch(/SELECT \?, id, organization_id, amount FROM payments/);
      expect(freeze[0]).toMatch(/created_at BETWEEN \? AND NOW\(\)/);
      expect(freeze[1]).toEqual([1, 1, 10, openSession.opened_at]);
      expect(sum[1]).toEqual([1, 1]);
      expect(q.calls.indexOf(freeze)).toBeLessThan(q.calls.indexOf(sum));
    });

    test('a payment an earlier close already counted is never counted again', async () => {
      const { q } = await close({ collected: '200.00' }, 700);
      const freeze = q.find(/^INSERT INTO cash_reconciliation_session_payments/)[0];
      expect(freeze).toMatch(/AND NOT EXISTS \( SELECT 1 FROM cash_reconciliation_session_payments counted WHERE counted\.payment_id = payments\.id AND counted\.organization_id = payments\.organization_id \)/);
      // The drawer of an open cashier and the supervisor's view leave it out too.
      const live = database({ session: { ...openSession, minutes_open: 5 } });
      await cashReconciliationService.myOpenSession(1, 10);
      expect(live.find(/AS collected FROM payments/)[0]).toMatch(/NOT EXISTS \( SELECT 1 FROM cash_reconciliation_session_payments counted/);
      const all = database();
      await cashReconciliationService.attention(1);
      expect(all.find(/FROM cash_reconciliation_sessions s WHERE/)[0]).toMatch(/counted\.payment_id = p\.id AND counted\.organization_id = p\.organization_id/);
    });

    test('reads the four cashier settings of the organization', async () => {
      const { q } = await close({ collected: '0.00' }, 500);
      const [sql, params] = q.find(/FROM organization_settings/);
      expect(sql).toMatch(/setting_key IN \(\?, \?, \?, \?\)/);
      expect(params).toEqual([1, 'cashier_match_tolerance', 'cashier_max_open_hours', 'cashier_pickup_threshold', 'cashier_pickup_strict']);
    });
  });

  // ===========================================================================
  // approveSession / disputeSession
  // ===========================================================================
  describe('reviewing a count that did not match', () => {
    const closedSession = { id: 1, organization_id: 1, agent_user_id: 10, status: 'closed', variance: '-20.00' };
    const answer = (session, after) => db.query
      .mockResolvedValueOnce([[session]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[after]]);

    test('throws NOT_FOUND when session not found', async () => {
      db.query.mockResolvedValueOnce([[]]);
      await expect(cashReconciliationService.approveSession(999, 1, { id: 5, role: 'manager' }, 'ok')).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });

    test('an open or already approved session cannot be approved', async () => {
      for (const status of ['open', 'approved']) {
        db.query.mockResolvedValueOnce([[{ ...closedSession, status }]]);
        await expect(cashReconciliationService.approveSession(1, 1, { id: 5, role: 'manager' }, 'explained')).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
      }
    });

    test('approving records who, why, and only moves a session still in the state that was read', async () => {
      answer(closedSession, { ...closedSession, status: 'approved', approved_by: 5, review_note: 'cambio mal dado, repuesto' });
      const result = await cashReconciliationService.approveSession(1, 1, { id: 5, role: 'manager' }, '  cambio mal dado, repuesto ');
      const [sql, params] = db.query.mock.calls[1];
      expect(sql).toMatch(/SET status = \?, approved_by = \?, approved_at = NOW\(\), review_note = \?/);
      expect(sql).toMatch(/AND status = \?/);
      expect(params).toEqual(['approved', 5, 'cambio mal dado, repuesto', 1, 1, 'closed']);
      expect(result).toMatchObject({ status: 'approved', approved_by: 5 });
    });

    test('a note explaining the difference is required', async () => {
      for (const note of [undefined, '', '  a ']) {
        db.query.mockResolvedValueOnce([[closedSession]]);
        await expect(cashReconciliationService.approveSession(1, 1, { id: 5, role: 'manager' }, note)).rejects.toMatchObject({ statusCode: 422 });
      }
      expect(db.query.mock.calls.some(([sql]) => /UPDATE/.test(sql))).toBe(false);
    });

    test('nobody reviews their own cashier', async () => {
      db.query.mockResolvedValueOnce([[closedSession]]);
      await expect(cashReconciliationService.approveSession(1, 1, { id: 10, role: 'manager' }, 'it is fine')).rejects.toMatchObject({ statusCode: 403, code: 'OWN_CASHIER' });
      db.query.mockResolvedValueOnce([[closedSession]]);
      await expect(cashReconciliationService.disputeSession(1, 1, { id: 10, role: 'manager' }, 'it is not')).rejects.toMatchObject({ statusCode: 403, code: 'OWN_CASHIER' });
      expect(db.query.mock.calls.some(([sql]) => /UPDATE/.test(sql))).toBe(false);
    });

    test('the company\'s admin, with nobody above them, may review their own cashier', async () => {
      answer(closedSession, { ...closedSession, status: 'approved', approved_by: 10 });
      const result = await cashReconciliationService.approveSession(1, 1, { id: 10, role: 'admin' }, 'faltaron 20, los repuse');
      expect(db.query.mock.calls[1][1]).toEqual(['approved', 10, 'faltaron 20, los repuse', 1, 1, 'closed']);
      // approved_by equal to the cashier's owner is what marks it as a self-review.
      expect(Number(result.approved_by)).toBe(Number(closedSession.agent_user_id));
      db.query.mockReset();
      db.query.mockResolvedValueOnce([[closedSession]]);
      await expect(cashReconciliationService.approveSession(1, 1, { id: 10, role: 'admin' }, '')).rejects.toMatchObject({ statusCode: 422 });
    });

    test('a manager or any other supervisor still cannot', async () => {
      for (const role of ['manager', 'billing', undefined]) {
        db.query.mockResolvedValueOnce([[closedSession]]);
        await expect(cashReconciliationService.approveSession(1, 1, { id: 10, role }, 'it is fine')).rejects.toMatchObject({ statusCode: 403, code: 'OWN_CASHIER' });
      }
    });

    test('disputing marks it disputed with the note', async () => {
      answer(closedSession, { ...closedSession, status: 'disputed', approved_by: 5 });
      const result = await cashReconciliationService.disputeSession(1, 1, { id: 5, role: 'manager' }, 'faltan 20 sin explicar');
      expect(db.query.mock.calls[1][1]).toEqual(['disputed', 5, 'faltan 20 sin explicar', 1, 1, 'closed']);
      expect(result.status).toBe('disputed');
    });

    test('a disputed session can be approved once it is settled, but not disputed again', async () => {
      const disputed = { ...closedSession, status: 'disputed' };
      answer(disputed, { ...disputed, status: 'approved' });
      await cashReconciliationService.approveSession(1, 1, { id: 5, role: 'manager' }, 'repuso los 20');
      expect(db.query.mock.calls[1][1]).toEqual(['approved', 5, 'repuso los 20', 1, 1, 'disputed']);
      db.query.mockResolvedValueOnce([[disputed]]);
      await expect(cashReconciliationService.disputeSession(1, 1, { id: 5, role: 'manager' }, 'otra vez')).rejects.toMatchObject({ statusCode: 422 });
    });
  });

  // ===========================================================================
  // reminders
  // ===========================================================================
  describe('the reminders', () => {
    const mine = { id: 7, agent_user_id: 10, opened_at: '2026-11-25 09:00:00', opening_total: '500.00', opening_expected: '500.00', minutes_open: 17 * 60 + 5 };

    test('my open cashier: what the drawer holds, and whether it is overdue', async () => {
      const q = database({ session: mine, collected: '3450.00', pickups: [{ status: 'confirmed', n: 1, total: '1000.00' }, { status: 'pending', n: 1, total: '200.00' }] });
      const out = await cashReconciliationService.myOpenSession(1, 10);
      expect(out).toEqual({
        id: 7, opened_at: '2026-11-25 09:00:00', hours_open: 17,
        expected_total: 2950, opening_total: 500, collected_total: 3450, pickups_total: 1000,
        pending_pickups: 1, pending_pickups_total: 200,
        max_open_hours: 16, overdue: true,
        pickup_threshold: 0, pickup_strict: false, over_threshold: false,
      });
      expect(q.find(/AS collected FROM payments/)[1]).toEqual([1, 10, '2026-11-25 09:00:00']);
    });

    test('my open cashier is null when none is open', async () => {
      database();
      expect(await cashReconciliationService.myOpenSession(1, 10)).toBeNull();
    });

    test('it is over the limit once the drawer holds the threshold, counting only confirmed pickups', async () => {
      const settings = [{ setting_key: 'cashier_pickup_threshold', setting_value: '5000' }, { setting_key: 'cashier_max_open_hours', setting_value: '24' }];
      const over = async (collected, pickups = []) => {
        database({ session: mine, collected, pickups, settings });
        return (await cashReconciliationService.myOpenSession(1, 10)).over_threshold;
      };
      expect(await over('4499.99')).toBe(false);                                               // 4,999.99 in the drawer
      expect(await over('4500.00')).toBe(true);                                                // exactly 5,000
      expect(await over('6000.00', [{ status: 'confirmed', n: 1, total: '3000.00' }])).toBe(false); // handed in
      expect(await over('6000.00', [{ status: 'pending', n: 1, total: '3000.00' }])).toBe(true);    // not confirmed yet
    });

    test('a supervisor sees who is open too long, who is over the limit, who opened with a difference, and the counts to review', async () => {
      const q = database({
        settings: [{ setting_key: 'cashier_pickup_threshold', setting_value: '5000' }],
        openSessions: [
          { id: 3, agent_user_id: 10, opened_at: 'y', opening_total: '500.00', opening_expected: '500.00', hours_open: 30, collected: '100.00', handed_in: '0.00' },
          { id: 4, agent_user_id: 11, opened_at: 'z', opening_total: '500.00', opening_expected: '700.00', hours_open: 2, collected: '6000.00', handed_in: '1000.00' },
          { id: 5, agent_user_id: 12, opened_at: 'w', opening_total: '0.00', opening_expected: null, hours_open: 1, collected: '10.00', handed_in: '0.00' },
        ],
        users: [{ id: 10, first_name: 'Ana', last_name: 'Ruiz' }, { id: 11, first_name: 'Luis', last_name: 'Peña' }],
        awaiting: 2,
      });
      const out = await cashReconciliationService.attention(1);
      expect(out.max_open_hours).toBe(16);
      expect(out.pickup_threshold).toBe(5000);
      expect(out.pickup_strict).toBe(false);
      expect(out.awaiting_review).toBe(2);
      expect(out.overdue_open.map((r) => [r.id, r.agent_name, r.hours_open])).toEqual([[3, 'Ana Ruiz', 30]]);
      expect(out.over_threshold.map((r) => [r.id, r.agent_name, r.cash_on_hand])).toEqual([[4, 'Luis Peña', 5500]]);
      expect(out.opening_differences.map((r) => [r.id, r.opening_difference])).toEqual([[4, -200]]);
      expect(q.find(/FROM cash_reconciliation_sessions s WHERE/)[1]).toEqual([1]);
    });

    test('with no threshold nobody is over the limit', async () => {
      database({ openSessions: [{ id: 4, agent_user_id: 11, opened_at: 'z', opening_total: '0.00', opening_expected: null, hours_open: 2, collected: '900000.00', handed_in: '0.00' }] });
      expect((await cashReconciliationService.attention(1)).over_threshold).toEqual([]);
    });

    test('a person with a cashier open past the allowed hours cannot take more cash', async () => {
      const q = database({ session: { ...mine, overdue: 1 } });
      await expect(cashReconciliationService.assertMayTakeCash(1, 10)).rejects.toMatchObject({ statusCode: 409, code: 'CASHIER_NOT_CLOSED' });
      expect(q.find(/opened_at <= DATE_SUB\(NOW\(\), INTERVAL \? HOUR\) AS overdue/)[1]).toEqual([16, 1, 10]);
    });

    test('over the limit only reminds, unless the supervisors made it strict', async () => {
      const threshold = { setting_key: 'cashier_pickup_threshold', setting_value: '5000' };
      database({ session: { ...mine, overdue: 0 }, collected: '9000.00', settings: [threshold] });
      await expect(cashReconciliationService.assertMayTakeCash(1, 10)).resolves.toBeUndefined();
      database({ session: { ...mine, overdue: 0 }, collected: '9000.00', settings: [threshold, { setting_key: 'cashier_pickup_strict', setting_value: 'true' }] });
      await expect(cashReconciliationService.assertMayTakeCash(1, 10)).rejects.toMatchObject({ statusCode: 409, code: 'CASHIER_OVER_LIMIT' });
    });

    test('strict: the payment that crosses the limit went through; under it nobody is stopped', async () => {
      const settings = [{ setting_key: 'cashier_pickup_threshold', setting_value: '5000' }, { setting_key: 'cashier_pickup_strict', setting_value: 'true' }];
      database({ session: { ...mine, overdue: 0 }, collected: '4499.99', settings });
      await expect(cashReconciliationService.assertMayTakeCash(1, 10)).resolves.toBeUndefined();
      // Strict with a threshold of 0 would stop everyone: 0 means there is no limit.
      database({ session: { ...mine, overdue: 0 }, collected: '4499.99', settings: [{ setting_key: 'cashier_pickup_strict', setting_value: 'true' }] });
      await expect(cashReconciliationService.assertMayTakeCash(1, 10)).resolves.toBeUndefined();
    });

    test('someone with no open cashier, or no user at all, is not stopped', async () => {
      database();
      await expect(cashReconciliationService.assertMayTakeCash(1, 10)).resolves.toBeUndefined();
      db.query.mockReset();
      await expect(cashReconciliationService.assertMayTakeCash(1, null)).resolves.toBeUndefined();
      expect(db.query).not.toHaveBeenCalled();
    });

    test('session rows get their owner\'s and reviewer\'s names; an automatic approval names nobody', async () => {
      database({ users: [{ id: 10, first_name: 'Ana', last_name: 'Ruiz' }, { id: 5, first_name: 'Luis', last_name: 'Peña' }] });
      const rows = [
        { id: 1, agent_user_id: 10, approved_by: 5 },
        { id: 2, agent_user_id: 10, approved_by: null },
        { id: 3, agent_user_id: 77, approved_by: null },
      ];
      await cashReconciliationService.addStaffNames(rows);
      expect(rows.map((r) => [r.agent_name, r.approved_by_name])).toEqual([['Ana Ruiz', 'Luis Peña'], ['Ana Ruiz', null], [null, null]]);
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('naming an empty list asks the database nothing', async () => {
      await cashReconciliationService.addStaffNames([]);
      expect(db.query).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // pickups
  // ===========================================================================
  describe('cash pickups', () => {
    const manager = { id: 5, role: 'manager' };
    const insert = (q) => q.find(/^INSERT INTO cash_reconciliation_pickups/);

    test('a supervisor takes cash from someone\'s open cashier: it waits for the owner', async () => {
      const q = database({ session: { ...openSession }, collected: '5000.00', pickup: { id: 9, status: 'pending' } });
      const out = await cashReconciliationService.createPickup(1, 1, manager, 4000, ' a la caja fuerte ');
      const [sql, params] = insert(q);
      expect(sql).toMatch(/VALUES \(\?, \?, \?, \?, \?, \?, NULL, \?\)/);
      expect(params).toEqual([1, 1, 4000, 'pending', 5, null, 'a la caja fuerte']);
      expect(out).toMatchObject({ id: 9 });
    });

    test('not more than the drawer holds, counting pickups already waiting', async () => {
      // 500 opening + 5,000 taken - 1,000 confirmed = 4,500 on hand; 2,000 more are waiting.
      const state = { session: { ...openSession }, collected: '5000.00', pickups: [{ status: 'confirmed', n: 1, total: '1000.00' }, { status: 'pending', n: 1, total: '2000.00' }] };
      let q = database(state);
      await expect(cashReconciliationService.createPickup(1, 1, manager, 2500.01, null)).rejects.toMatchObject({ statusCode: 422 });
      expect(insert(q)).toBeUndefined();
      q = database({ ...state, pickup: { id: 9 } });
      await cashReconciliationService.createPickup(1, 1, manager, 2500, null);
      expect(insert(q)[1][2]).toBe(2500);
    });

    test('the amount must be more than zero, and the cashier open', async () => {
      database({ session: { ...openSession } });
      for (const amount of [0, -5, 'x']) {
        await expect(cashReconciliationService.createPickup(1, 1, manager, amount, null)).rejects.toMatchObject({ statusCode: 422 });
      }
      database({ session: { ...openSession, status: 'closed' }, collected: '5000.00' });
      await expect(cashReconciliationService.createPickup(1, 1, manager, 100, null)).rejects.toMatchObject({ statusCode: 422 });
      database();
      await expect(cashReconciliationService.createPickup(1, 99, manager, 100, null)).rejects.toMatchObject({ statusCode: 404 });
    });

    test('nobody picks up from their own cashier, except the company\'s admin, whose pickup is confirmed at once', async () => {
      let q = database({ session: { ...openSession }, collected: '5000.00' });
      await expect(cashReconciliationService.createPickup(1, 1, { id: 10, role: 'manager' }, 100, null)).rejects.toMatchObject({ statusCode: 403, code: 'OWN_CASHIER' });
      expect(insert(q)).toBeUndefined();
      q = database({ session: { ...openSession }, collected: '5000.00', pickup: { id: 9 } });
      await cashReconciliationService.createPickup(1, 1, { id: 10, role: 'admin' }, 100, null);
      const [sql, params] = insert(q);
      expect(sql).toMatch(/VALUES \(\?, \?, \?, \?, \?, \?, NOW\(\), \?\)/);
      expect(params).toEqual([1, 1, 100, 'confirmed', 10, 10, null]);
    });

    test('only the cashier\'s owner confirms, and only while it waits', async () => {
      const pending = { id: 9, session_id: 1, status: 'pending', taken_by: 5, amount: '4000.00' };
      let q = database({ session: { ...openSession }, pickup: pending });
      await cashReconciliationService.confirmPickup(1, 9, 10);
      const [sql, params] = q.find(/^UPDATE cash_reconciliation_pickups/);
      expect(sql).toMatch(/SET status = 'confirmed', confirmed_by = \?, confirmed_at = NOW\(\) WHERE id = \? AND organization_id = \? AND status = 'pending'/);
      expect(params).toEqual([10, 9, 1]);

      q = database({ session: { ...openSession }, pickup: pending });
      await expect(cashReconciliationService.confirmPickup(1, 9, 5)).rejects.toMatchObject({ statusCode: 403, code: 'NOT_YOUR_CASHIER' });
      expect(q.find(/^UPDATE cash_reconciliation_pickups/)).toBeUndefined();

      database({ session: { ...openSession }, pickup: { ...pending, status: 'confirmed' } });
      await expect(cashReconciliationService.confirmPickup(1, 9, 10)).rejects.toMatchObject({ statusCode: 422 });
      database({ session: { ...openSession } });
      await expect(cashReconciliationService.confirmPickup(1, 404, 10)).rejects.toMatchObject({ statusCode: 404 });
    });

    test('a waiting pickup is cancelled by the owner or by the supervisor who recorded it, nobody else', async () => {
      const pending = { id: 9, session_id: 1, status: 'pending', taken_by: 5, amount: '4000.00' };
      for (const who of [10, 5]) {
        const q = database({ session: { ...openSession }, pickup: pending });
        await cashReconciliationService.cancelPickup(1, 9, who);
        expect(q.find(/^UPDATE cash_reconciliation_pickups/)[1]).toEqual([who, 9, 1]);
      }
      let q = database({ session: { ...openSession }, pickup: pending });
      await expect(cashReconciliationService.cancelPickup(1, 9, 6)).rejects.toMatchObject({ statusCode: 403, code: 'NOT_YOUR_PICKUP' });
      expect(q.find(/^UPDATE cash_reconciliation_pickups/)).toBeUndefined();
      q = database({ session: { ...openSession }, pickup: { ...pending, status: 'confirmed' } });
      await expect(cashReconciliationService.cancelPickup(1, 9, 10)).rejects.toMatchObject({ statusCode: 422 });
    });

    test('a pickup is always looked up inside the caller\'s organization', async () => {
      const q = database({ session: { ...openSession } });
      await expect(cashReconciliationService.confirmPickup(2, 9, 10)).rejects.toMatchObject({ statusCode: 404 });
      expect(q.find(/^SELECT \* FROM cash_reconciliation_pickups WHERE id = \? AND organization_id = \?/)[1]).toEqual([9, 2]);
    });
  });

  // ===========================================================================
  // the rules a supervisor sets
  // ===========================================================================
  describe('pickup rules', () => {
    test('a supervisor sets the threshold and whether it is strict', async () => {
      const q = database({ settings: [{ setting_key: 'cashier_pickup_threshold', setting_value: '5000' }, { setting_key: 'cashier_pickup_strict', setting_value: 'true' }] });
      const out = await cashReconciliationService.setPickupRules(1, { pickup_threshold: 5000, pickup_strict: true });
      const writes = q.calls.filter(([text]) => /^INSERT INTO organization_settings/.test(text)).map(([, params]) => params);
      expect(writes).toEqual([[1, 'cashier_pickup_threshold', '5000'], [1, 'cashier_pickup_strict', 'true']]);
      expect(out).toMatchObject({ pickupThreshold: 5000, pickupStrict: true });
    });

    test('only what was sent is changed, and a bad value changes nothing', async () => {
      let q = database();
      await cashReconciliationService.setPickupRules(1, { pickup_strict: false });
      expect(q.calls.filter(([text]) => /^INSERT INTO organization_settings/.test(text)).map(([, p]) => p)).toEqual([[1, 'cashier_pickup_strict', 'false']]);
      q = database();
      await expect(cashReconciliationService.setPickupRules(1, { pickup_threshold: -1, pickup_strict: true })).rejects.toMatchObject({ statusCode: 422 });
      expect(q.find(/^INSERT INTO organization_settings/)).toBeUndefined();
    });
  });

  // ===========================================================================
  describe('getSessionDetail', () => {
    test('returns session with cash_payments array', async () => {
      const session = {
        id: 1,
        organization_id: 1,
        agent_user_id: 10,
        opened_at: new Date(Date.now() - 7200000).toISOString(),
        closed_at: new Date(Date.now() - 3600000).toISOString(),
        status: 'closed',
      };
      const payments = [
        { id: 1, amount: '100.00', payment_method: 'cash' },
        { id: 2, amount: '150.00', payment_method: 'cash' },
      ];

      db.query
        .mockResolvedValueOnce([[session]])
        .mockResolvedValueOnce([payments]);

      const result = await cashReconciliationService.getSessionDetail(1, 1);

      expect(result.session).toEqual(session);
      expect(result.payments).toHaveLength(2);
    });

    test('throws NOT_FOUND when session does not exist', async () => {
      db.query.mockResolvedValueOnce([[]]); // no session

      await expect(
        cashReconciliationService.getSessionDetail(999, 1),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });

    test('queries an open session\'s payments with correct org and agent filters', async () => {
      const session = {
        id: 2,
        organization_id: 7,
        agent_user_id: 33,
        opened_at: '2025-01-01T08:00:00Z',
        closed_at: null,
        status: 'open',
      };

      db.query
        .mockResolvedValueOnce([[session]])
        .mockResolvedValueOnce([[]]); // no payments

      const result = await cashReconciliationService.getSessionDetail(2, 7);

      const paymentsCall = db.query.mock.calls[1];
      expect(paymentsCall[0]).toContain("payment_method = 'cash'");
      expect(paymentsCall[1]).toContain(7);   // orgId
      expect(paymentsCall[1]).toContain(33);  // agent_user_id
    });

    // A payment deleted, refunded or re-dated after the close used to drop
    // out of a closed session's list while its expected_total stayed.
    test('a closed session shows the payments its close froze, not the window', async () => {
      const session = {
        id: 2, organization_id: 7, agent_user_id: 33, status: 'approved',
        opened_at: '2025-01-01T08:00:00Z', closed_at: '2025-01-01T17:00:00Z',
      };
      const frozen = [{ id: 11, amount: '100.00', current_amount: '100.00', status: 'refunded' }];
      db.query.mockResolvedValueOnce([[session]]).mockResolvedValueOnce([frozen]);

      const result = await cashReconciliationService.getSessionDetail(2, 7);

      const [sql, params] = db.query.mock.calls[1];
      expect(sql).toMatch(/JOIN payments p ON p\.id = sp\.payment_id AND p\.organization_id = sp\.organization_id/);
      expect(sql).toMatch(/WHERE sp\.session_id = \? AND sp\.organization_id = \?/);
      expect(sql).not.toMatch(/deleted_at IS NULL|status = 'completed'/);
      expect(params).toEqual([2, 7]);
      expect(result.payments).toEqual(frozen);
    });

    test('uses current time as window end when session is still open', async () => {
      const session = {
        id: 3,
        organization_id: 1,
        agent_user_id: 10,
        opened_at: new Date(Date.now() - 3600000).toISOString(),
        closed_at: null, // still open
        status: 'open',
      };

      db.query
        .mockResolvedValueOnce([[session]])
        .mockResolvedValueOnce([[]]); // no payments

      await cashReconciliationService.getSessionDetail(3, 1);

      // Should still succeed (using current time as window end)
      expect(db.query).toHaveBeenCalledTimes(2);
    });
  });
});
