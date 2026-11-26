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

  // ===========================================================================
  // openSession
  // ===========================================================================
  describe('openSession', () => {
    test('throws ValidationError when agent already has an open session', async () => {
      db.query.mockResolvedValueOnce([[{ id: 5 }]]); // existing open session

      await expect(
        cashReconciliationService.openSession({ organizationId: 1, agentUserId: 10, notes: null }),
      ).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });

      // Should not proceed to INSERT
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('creates new session when no open session exists', async () => {
      const newSession = {
        id: 1,
        organization_id: 1,
        agent_user_id: 10,
        status: 'open',
        notes: 'test note',
      };

      db.query
        .mockResolvedValueOnce([[]])           // no existing session
        .mockResolvedValueOnce([{ insertId: 1 }]) // INSERT
        .mockResolvedValueOnce([[newSession]]); // SELECT after insert

      const result = await cashReconciliationService.openSession({
        organizationId: 1,
        agentUserId: 10,
        notes: 'test note',
      });

      expect(db.query).toHaveBeenCalledTimes(3);
      expect(result).toEqual(newSession);
    });

    test('queries for open session with correct org and agent', async () => {
      db.query.mockResolvedValueOnce([[]]); // no existing
      db.query.mockResolvedValueOnce([{ insertId: 2 }]);
      db.query.mockResolvedValueOnce([[{ id: 2 }]]);

      await cashReconciliationService.openSession({ organizationId: 99, agentUserId: 55, notes: null });

      const checkCall = db.query.mock.calls[0];
      expect(checkCall[0]).toContain("status = 'open'");
      expect(checkCall[1]).toContain(99);
      expect(checkCall[1]).toContain(55);
    });
  });

  // ===========================================================================
  // closeSession
  // ===========================================================================
  describe('closeSession', () => {
    const openSession = {
      id: 1,
      organization_id: 1,
      agent_user_id: 10,
      opened_at: new Date(Date.now() - 3600000).toISOString(),
      status: 'open',
    };

    test('computes expected_total from cash payments in the window', async () => {
      db.query
        .mockResolvedValueOnce([[openSession]])             // SELECT session
        .mockResolvedValueOnce([{ affectedRows: 2 }])       // INSERT the window's payments into the snapshot
        .mockResolvedValueOnce([[{ expected_total: '200.00' }]]) // SUM payments
        .mockResolvedValueOnce([[]])                          // the organization's cashier settings: none stored
        .mockResolvedValueOnce([{ affectedRows: 1 }])       // UPDATE
        .mockResolvedValueOnce([[{ ...openSession, status: 'closed', expected_total: '200.00', counted_total: '220.00', variance: '20.00' }]]); // SELECT updated

      const result = await cashReconciliationService.closeSession(1, 1, 220);

      // Verify the UPDATE was called with the right values
      const updateCall = db.query.mock.calls[4];
      expect(updateCall[1]).toContain('closed'); // 220 counted against 200: a supervisor has to look
      expect(updateCall[0]).toContain('approved_at = NULL');
      expect(updateCall[1]).toContain(200);  // expectedTotal
      expect(updateCall[1]).toContain(220);  // countedTotal
    });

    test('computes variance correctly as counted - expected', async () => {
      db.query
        .mockResolvedValueOnce([[openSession]])
        .mockResolvedValueOnce([{ affectedRows: 2 }])       // INSERT the window's payments into the snapshot
        .mockResolvedValueOnce([[{ expected_total: '300.00' }]])
        .mockResolvedValueOnce([[]])                          // the organization's cashier settings: none stored
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([[{ ...openSession, status: 'closed', variance: '50.00' }]]);

      await cashReconciliationService.closeSession(1, 1, 350);

      const updateCall = db.query.mock.calls[4];
      // variance = 350 - 300 = 50
      expect(updateCall[1]).toContain(50);
    });

    test('computes negative variance correctly', async () => {
      db.query
        .mockResolvedValueOnce([[openSession]])
        .mockResolvedValueOnce([{ affectedRows: 2 }])       // INSERT the window's payments into the snapshot
        .mockResolvedValueOnce([[{ expected_total: '500.00' }]])
        .mockResolvedValueOnce([[]])                          // the organization's cashier settings: none stored
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([[{ ...openSession, status: 'closed', variance: '-25.00' }]]);

      await cashReconciliationService.closeSession(1, 1, 475);

      const updateCall = db.query.mock.calls[4];
      // variance = 475 - 500 = -25
      expect(updateCall[1]).toContain(-25);
    });

    test('throws NOT_FOUND when session not found', async () => {
      db.query.mockResolvedValueOnce([[]]); // no session

      await expect(
        cashReconciliationService.closeSession(999, 1, 100),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });

    test('throws ValidationError when session is not open', async () => {
      db.query.mockResolvedValueOnce([[{ ...openSession, status: 'closed' }]]);

      await expect(
        cashReconciliationService.closeSession(1, 1, 100),
      ).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
    });

    test('a count that matches is approved on the spot, with no approver', async () => {
      db.query
        .mockResolvedValueOnce([[openSession]])
        .mockResolvedValueOnce([{ affectedRows: 2 }])
        .mockResolvedValueOnce([[{ expected_total: '100.00' }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([[{ ...openSession, status: 'approved' }]]);

      await cashReconciliationService.closeSession(1, 1, 100);

      const updateCall = db.query.mock.calls[4];
      expect(updateCall[1]).toContain('approved');
      expect(updateCall[1]).not.toContain('closed');
      expect(updateCall[0]).toContain('approved_at = NOW()');
      expect(updateCall[0]).toContain('approved_by = NULL');
    });

    test('a difference within the organization\'s tolerance still counts as a match; a larger one does not', async () => {
      const closeWith = async (counted) => {
        db.query.mockReset();
        db.query
          .mockResolvedValueOnce([[openSession]])
          .mockResolvedValueOnce([{ affectedRows: 2 }])
          .mockResolvedValueOnce([[{ expected_total: '100.00' }]])
          .mockResolvedValueOnce([[{ setting_key: 'cashier_match_tolerance', setting_value: '5' }]])
          .mockResolvedValueOnce([{ affectedRows: 1 }])
          .mockResolvedValueOnce([[openSession]]);
        await cashReconciliationService.closeSession(1, 1, counted);
        const settings = db.query.mock.calls[3];
        expect(settings[0]).toMatch(/FROM organization_settings/);
        expect(settings[1]).toEqual([1, 'cashier_match_tolerance', 'cashier_max_open_hours']);
        return db.query.mock.calls[4][1];
      };
      expect(await closeWith(97)).toContain('approved');   // 3 short
      expect(await closeWith(105)).toContain('approved');  // exactly 5 over
      expect(await closeWith(105.01)).toContain('closed'); // a cent past it
      expect(await closeWith(94)).toContain('closed');     // 6 short
    });

    test('a stored tolerance the settings would refuse today is ignored', async () => {
      db.query
        .mockResolvedValueOnce([[openSession]])
        .mockResolvedValueOnce([{ affectedRows: 2 }])
        .mockResolvedValueOnce([[{ expected_total: '100.00' }]])
        .mockResolvedValueOnce([[{ setting_key: 'cashier_match_tolerance', setting_value: 'lots' }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([[openSession]]);
      await cashReconciliationService.closeSession(1, 1, 99);
      expect(db.query.mock.calls[4][1]).toContain('closed');
    });

    // The total and the list a closed session shows come from one frozen set:
    // the payments are copied first and expected_total is their sum.
    test('freezes the window\'s payments and sums what it froze', async () => {
      db.query
        .mockResolvedValueOnce([[openSession]])
        .mockResolvedValueOnce([{ affectedRows: 2 }])
        .mockResolvedValueOnce([[{ expected_total: '200.00' }]])
        .mockResolvedValueOnce([[]])                          // the organization's cashier settings: none stored
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([[{ ...openSession, status: 'closed' }]]);

      await cashReconciliationService.closeSession(1, 1, 200);

      const [lock, freeze, sum] = db.query.mock.calls;
      expect(lock[0]).toMatch(/FOR UPDATE/);
      expect(freeze[0]).toMatch(/INSERT INTO cash_reconciliation_session_payments[\s\S]*SELECT \?, id, organization_id, amount\s+FROM payments/);
      expect(freeze[0]).toMatch(/created_at BETWEEN \? AND NOW\(\)/);
      expect(freeze[1]).toEqual([1, 1, 10, openSession.opened_at]);
      expect(sum[0]).toMatch(/FROM cash_reconciliation_session_payments\s+WHERE session_id = \? AND organization_id = \?/);
      expect(sum[1]).toEqual([1, 1]);
    });

    test('rolls the freeze back when the session is not open', async () => {
      const conn = {
        beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
        query: (...args) => db.query(...args),
      };
      db.getConnection.mockResolvedValueOnce(conn);
      db.query.mockResolvedValueOnce([[{ ...openSession, status: 'closed' }]]);

      await expect(cashReconciliationService.closeSession(1, 1, 100)).rejects.toMatchObject({ statusCode: 422 });
      expect(conn.rollback).toHaveBeenCalled();
      expect(conn.commit).not.toHaveBeenCalled();
      expect(db.query.mock.calls.some(([sql]) => /INSERT INTO cash_reconciliation_session_payments/.test(sql))).toBe(false);
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
    test('my open cashier: when it opened, the cash so far and whether it is overdue', async () => {
      db.query
        .mockResolvedValueOnce([[{ id: 7, opened_at: '2026-11-25 09:00:00', minutes_open: 17 * 60 + 5 }]])
        .mockResolvedValueOnce([[]])                               // settings: defaults (16 hours)
        .mockResolvedValueOnce([[{ expected_total: '3450.00' }]]);
      const mine = await cashReconciliationService.myOpenSession(1, 10);
      expect(mine).toEqual({ id: 7, opened_at: '2026-11-25 09:00:00', hours_open: 17, expected_total: 3450, max_open_hours: 16, overdue: true });
      expect(db.query.mock.calls[0][1]).toEqual([1, 10]);
      expect(db.query.mock.calls[2][1]).toEqual([1, 10, '2026-11-25 09:00:00']);
    });

    test('my open cashier is null when none is open, and not overdue inside the allowed hours', async () => {
      db.query.mockResolvedValueOnce([[]]);
      expect(await cashReconciliationService.myOpenSession(1, 10)).toBeNull();
      db.query
        .mockResolvedValueOnce([[{ id: 7, opened_at: 'x', minutes_open: 120 }]])
        .mockResolvedValueOnce([[{ setting_key: 'cashier_max_open_hours', setting_value: '8' }]])
        .mockResolvedValueOnce([[{ expected_total: '0.00' }]]);
      expect(await cashReconciliationService.myOpenSession(1, 10)).toMatchObject({ hours_open: 2, max_open_hours: 8, overdue: false });
    });

    test('a supervisor sees cashiers open too long, with their owners, and how many counts wait for review', async () => {
      db.query
        .mockResolvedValueOnce([[]])                                                        // settings
        .mockResolvedValueOnce([[{ id: 3, agent_user_id: 10, opened_at: 'y', hours_open: 30 }]])
        .mockResolvedValueOnce([[{ id: 10, first_name: 'Ana', last_name: 'Ruiz' }]])
        .mockResolvedValueOnce([[{ n: 2 }]]);
      const out = await cashReconciliationService.attention(1);
      expect(out).toEqual({
        max_open_hours: 16,
        overdue_open: [{ id: 3, agent_user_id: 10, agent_name: 'Ana Ruiz', opened_at: 'y', hours_open: 30 }],
        awaiting_review: 2,
      });
      expect(db.query.mock.calls[1][1]).toEqual([1, 16]);
      expect(db.query.mock.calls[3][0]).toMatch(/status = 'closed'/);
    });

    test('session rows get their owner\'s and reviewer\'s names; an automatic approval names nobody', async () => {
      db.query.mockResolvedValueOnce([[{ id: 10, first_name: 'Ana', last_name: 'Ruiz' }, { id: 5, first_name: 'Luis', last_name: 'Peña' }]]);
      const rows = [
        { id: 1, agent_user_id: 10, approved_by: 5 },
        { id: 2, agent_user_id: 10, approved_by: null },
        { id: 3, agent_user_id: 77, approved_by: null },
      ];
      await cashReconciliationService.addStaffNames(rows);
      expect(rows.map((r) => [r.agent_name, r.approved_by_name])).toEqual([['Ana Ruiz', 'Luis Peña'], ['Ana Ruiz', null], [null, null]]);
      expect(db.query).toHaveBeenCalledTimes(1);
      expect(db.query.mock.calls[0][1].sort()).toEqual([10, 5, 77].sort());
    });

    test('naming an empty list asks the database nothing', async () => {
      await cashReconciliationService.addStaffNames([]);
      expect(db.query).not.toHaveBeenCalled();
    });

    test('a person with a cashier open past the allowed hours cannot take more cash', async () => {
      db.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ id: 3 }]]);
      await expect(cashReconciliationService.assertCashierNotOverdue(1, 10)).rejects.toMatchObject({ statusCode: 409, code: 'CASHIER_NOT_CLOSED' });
      expect(db.query.mock.calls[1][1]).toEqual([1, 10, 16]);
    });

    test('someone with no overdue cashier, or no user at all, is not stopped', async () => {
      db.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
      await expect(cashReconciliationService.assertCashierNotOverdue(1, 10)).resolves.toBeUndefined();
      db.query.mockReset();
      await expect(cashReconciliationService.assertCashierNotOverdue(1, null)).resolves.toBeUndefined();
      expect(db.query).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // getSessionDetail
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
