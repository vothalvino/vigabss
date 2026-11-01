// =============================================================================
// VigaBSS 5.0 — Payment Plan Service Unit Tests
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
const paymentPlanService = require('../src/services/paymentPlanService');

describe('paymentPlanService', () => {
  let mockConnection;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection = {
      beginTransaction: jest.fn(),
      execute: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    db.getConnection.mockResolvedValue(mockConnection);
  });

  // ===========================================================================
  // createPlan
  // ===========================================================================
  describe('createPlan', () => {
    // BIL-17: neither the plan nor its installments stored the invoice, so
    // paying an installment never allocated to it and the invoice stayed due.
    test('a plan for an invoice splits its balance due and links every installment to it', async () => {
      db.query
        .mockResolvedValueOnce([[{ id: 99, client_id: 5, status: 'issued', total: '1160.00', balance_due: '900.00' }]])
        .mockResolvedValueOnce([[{ id: 7, total_amount: '900.00' }]]);
      mockConnection.execute.mockResolvedValue([{ insertId: 7 }]);

      const { installments } = await paymentPlanService.createPlan({
        organizationId: 1, clientId: 5, invoiceId: 99, installmentCount: 3, frequency: 'monthly', createdBy: 8,
      });

      expect(db.query.mock.calls[0][0]).toMatch(/AS balance_due/);
      const planInsert = mockConnection.execute.mock.calls.find(([sql]) => /INSERT INTO payment_plans/.test(sql));
      expect(planInsert[1][2]).toBe(900);
      const instInserts = mockConnection.execute.mock.calls.filter(([sql]) => /INSERT INTO payment_plan_installments/.test(sql));
      expect(instInserts).toHaveLength(3);
      for (const [sql, params] of instInserts) {
        expect(sql).toMatch(/\(organization_id, plan_id, invoice_id, sequence/);
        expect(params.slice(0, 3)).toEqual([1, 7, 99]);
      }
      expect(installments.every((i) => i.invoice_id === 99)).toBe(true);
    });

    test('a paid invoice cannot be split into a plan', async () => {
      db.query.mockResolvedValueOnce([[{ id: 99, client_id: 5, status: 'paid', total: '1160.00', balance_due: '0.00' }]]);
      await expect(paymentPlanService.createPlan({
        organizationId: 1, clientId: 5, invoiceId: 99, installmentCount: 3, frequency: 'monthly',
      })).rejects.toThrow(/Only an unpaid invoice/);
      expect(mockConnection.execute).not.toHaveBeenCalled();
    });

    test('creates plan and installments for monthly frequency', async () => {
      const planId = 7;
      const inst1Id = 101;
      const inst2Id = 102;
      const inst3Id = 103;

      // INSERT payment_plans
      mockConnection.execute
        .mockResolvedValueOnce([{ insertId: planId }])
        // INSERT installment 1
        .mockResolvedValueOnce([{ insertId: inst1Id }])
        // INSERT installment 2
        .mockResolvedValueOnce([{ insertId: inst2Id }])
        // INSERT installment 3
        .mockResolvedValueOnce([{ insertId: inst3Id }]);

      // SELECT plan after insert
      db.query.mockResolvedValueOnce([[{
        id: planId,
        organization_id: 1,
        client_id: 5,
        total_amount: '100.00',
        installment_count: 3,
        frequency: 'monthly',
        status: 'active',
      }]]);

      const result = await paymentPlanService.createPlan({
        organizationId: 1,
        clientId: 5,
        totalAmount: 100,
        installmentCount: 3,
        frequency: 'monthly',
        createdBy: 2,
      });

      expect(mockConnection.beginTransaction).toHaveBeenCalled();
      expect(mockConnection.execute).toHaveBeenCalledTimes(4); // 1 plan + 3 installments
      expect(mockConnection.commit).toHaveBeenCalled();
      expect(mockConnection.release).toHaveBeenCalled();

      expect(result.plan.id).toBe(planId);
      expect(result.installments).toHaveLength(3);
      expect(result.installments[0].sequence).toBe(1);
      expect(result.installments[1].sequence).toBe(2);
      expect(result.installments[2].sequence).toBe(3);
    });

    test('splits amounts correctly for 3 installments of $100', async () => {
      mockConnection.execute
        .mockResolvedValueOnce([{ insertId: 10 }])   // plan
        .mockResolvedValueOnce([{ insertId: 11 }])   // inst 1
        .mockResolvedValueOnce([{ insertId: 12 }])   // inst 2
        .mockResolvedValueOnce([{ insertId: 13 }]);  // inst 3

      db.query.mockResolvedValueOnce([[{ id: 10, total_amount: '100.00' }]]);

      const result = await paymentPlanService.createPlan({
        organizationId: 1,
        clientId: 5,
        totalAmount: 100,
        installmentCount: 3,
        frequency: 'monthly',
        createdBy: 2,
      });

      // splitAmounts(100, 3): unit = floor(100/3*100)/100 = 33.33
      // amounts = [33.33, 33.33, 33.34]
      expect(result.installments[0].amount).toBe(33.33);
      expect(result.installments[1].amount).toBe(33.33);
      expect(result.installments[2].amount).toBe(33.34);
    });

    test('when invoiceId provided, overrides totalAmount with invoice.total', async () => {
      // First call: SELECT invoice
      db.query.mockResolvedValueOnce([[{ id: 50, client_id: 5, total: '250.00', status: 'issued' }]]);

      mockConnection.execute
        .mockResolvedValueOnce([{ insertId: 20 }])  // plan
        .mockResolvedValueOnce([{ insertId: 21 }])  // inst 1
        .mockResolvedValueOnce([{ insertId: 22 }]); // inst 2

      // SELECT plan after insert
      db.query.mockResolvedValueOnce([[{ id: 20, total_amount: '250.00' }]]);

      const result = await paymentPlanService.createPlan({
        organizationId: 1,
        clientId: 5,
        invoiceId: 50,
        totalAmount: 999, // should be overridden
        installmentCount: 2,
        frequency: 'monthly',
        createdBy: 2,
      });

      // The plan INSERT should use the invoice total (250), not 999
      const planInsertCall = mockConnection.execute.mock.calls[0];
      expect(planInsertCall[1]).toContain(250);
      expect(result.installments).toHaveLength(2);
    });

    test('throws NOT_FOUND when invoiceId does not exist', async () => {
      db.query.mockResolvedValueOnce([[]]); // invoice not found

      await expect(
        paymentPlanService.createPlan({
          organizationId: 1,
          clientId: 5,
          invoiceId: 9999,
          installmentCount: 2,
          frequency: 'monthly',
          createdBy: 2,
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });

    test('rolls back and rethrows on DB error', async () => {
      mockConnection.execute.mockRejectedValueOnce(new Error('DB insert failed'));

      await expect(
        paymentPlanService.createPlan({
          organizationId: 1,
          clientId: 5,
          totalAmount: 100,
          installmentCount: 2,
          frequency: 'weekly',
          createdBy: 2,
        }),
      ).rejects.toThrow('DB insert failed');

      expect(mockConnection.rollback).toHaveBeenCalled();
      expect(mockConnection.release).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // payInstallment
  // ===========================================================================
  describe('payInstallment', () => {
    // The reads run on the transaction, with the plan, installment, payment and
    // invoice rows locked; answer them by statement rather than by position.
    function wire({ plan = { id: 1, organization_id: 1, client_id: 10, status: 'active' },
      installment, payment, allocated = '0', usedBy = null, invoice = null, remaining = 2 }) {
      mockConnection.execute.mockImplementation(async (sql) => {
        if (/FROM payment_plans WHERE id = \?/.test(sql)) return [plan ? [plan] : []];
        if (/FROM payment_plan_installments WHERE plan_id = \? AND sequence = \?/.test(sql)) return [installment ? [installment] : []];
        if (/FROM payments WHERE id = \?/.test(sql)) return [payment ? [payment] : []];
        if (/WHERE paid_payment_id = \?/.test(sql)) return [usedBy ? [{ id: usedBy }] : []];
        if (/AS allocated FROM payment_allocations WHERE payment_id = \?/.test(sql)) return [[{ allocated }]];
        if (/FROM invoices i/.test(sql)) return [invoice ? [invoice] : []];
        if (/total_allocated/.test(sql)) return [[{ total_allocated: invoice ? invoice.total : 0 }]];
        if (/COUNT\(\*\) AS remaining/.test(sql)) return [[{ remaining }]];
        return [{ affectedRows: 1 }];
      });
      db.query.mockResolvedValue([[{ ...installment, status: 'paid' }]]);
    }
    const sqls = () => mockConnection.execute.mock.calls.map(([sql]) => sql);

    test('marks installment as paid and allocates to its invoice, inside the transaction', async () => {
      const installment = { id: 10, plan_id: 1, sequence: 2, amount: '50.00', invoice_id: 99, status: 'pending' };
      wire({
        installment,
        payment: { id: 5, organization_id: 1, client_id: 10, amount: '50.00', status: 'completed' },
        invoice: { id: 99, client_id: 10, total: '150.00', balance_due: '150.00', status: 'issued' },
      });

      const result = await paymentPlanService.payInstallment(1, 2, 5, 1);

      expect(mockConnection.beginTransaction).toHaveBeenCalled();
      const alloc = mockConnection.execute.mock.calls.find(([sql]) => /INSERT INTO payment_allocations/.test(sql));
      expect(alloc[1]).toEqual([5, 99, 50]);
      expect(sqls().some((sql) => /SET status = 'paid', paid_payment_id = \?/.test(sql))).toBe(true);
      expect(mockConnection.commit).toHaveBeenCalled();
      expect(result.status).toBe('paid');
    });

    test('locks the plan, the installment and the payment', async () => {
      wire({
        installment: { id: 10, plan_id: 1, sequence: 1, amount: '50.00', invoice_id: null, status: 'pending' },
        payment: { id: 5, organization_id: 1, client_id: 10, amount: '50.00', status: 'completed' },
      });
      await paymentPlanService.payInstallment(1, 1, 5, 1);
      for (const table of ['payment_plans', 'payment_plan_installments', 'payments']) {
        expect(sqls().some((sql) => new RegExp(`FROM ${table} WHERE.*FOR UPDATE`).test(sql))).toBe(true);
      }
    });

    test('marks plan as completed when all installments are paid', async () => {
      wire({
        installment: { id: 11, plan_id: 1, sequence: 1, amount: '100.00', invoice_id: null, status: 'pending' },
        payment: { id: 6, organization_id: 1, client_id: 10, amount: '100.00', status: 'completed' },
        remaining: 0,
      });

      await paymentPlanService.payInstallment(1, 1, 6, 1);

      const planUpdate = mockConnection.execute.mock.calls.find(([sql]) => /UPDATE payment_plans SET status = 'completed'/.test(sql));
      expect(planUpdate[1]).toEqual([1]);
    });

    test('throws NOT_FOUND if plan does not exist for org', async () => {
      wire({ plan: null });
      await expect(paymentPlanService.payInstallment(999, 1, 1, 1))
        .rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
      expect(mockConnection.rollback).toHaveBeenCalled();
    });

    test('throws NOT_FOUND if installment does not exist', async () => {
      wire({ installment: null });
      await expect(paymentPlanService.payInstallment(1, 999, 1, 1))
        .rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });

    test('throws ValidationError if installment is already paid', async () => {
      wire({ installment: { id: 10, plan_id: 1, sequence: 1, status: 'paid' } });
      await expect(paymentPlanService.payInstallment(1, 1, 5, 1))
        .rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
    });

    test('does not create allocation when invoice_id is null', async () => {
      wire({
        installment: { id: 12, plan_id: 1, sequence: 1, amount: '75.00', invoice_id: null, status: 'pending' },
        payment: { id: 7, organization_id: 1, client_id: 10, amount: '75.00', status: 'completed' },
      });
      await paymentPlanService.payInstallment(1, 1, 7, 1);
      expect(sqls().some((sql) => /INSERT INTO payment_allocations/.test(sql))).toBe(false);
    });

    // BIL-17: any payment could mark any number of installments paid.
    describe('refuses a payment that cannot pay the installment', () => {
      const installment = { id: 10, plan_id: 1, sequence: 1, amount: '100.00', invoice_id: 99, status: 'pending' };
      const payment = { id: 5, organization_id: 1, client_id: 10, amount: '100.00', status: 'completed' };

      test.each([
        ['another client\'s payment', { payment: { ...payment, client_id: 11 } }, /different client/],
        ['a payment that already paid an installment', { payment, usedBy: 9 }, /already settled another installment/],
        ['a payment without enough left unallocated', { payment: { ...payment, amount: '30.00' } }, /left unallocated/],
        ['a payment already spent on invoices', { payment, allocated: '80.00' }, /20\.00 left unallocated/],
        ['a plan that is no longer active', { payment, plan: { id: 1, organization_id: 1, client_id: 10, status: 'cancelled' } }, /plan is cancelled/],
      ])('%s', async (_name, over, message) => {
        wire({ installment, ...over });
        await expect(paymentPlanService.payInstallment(1, 1, 5, 1)).rejects.toThrow(message);
        expect(sqls().some((sql) => /^\s*(INSERT|UPDATE)/.test(sql))).toBe(false);
        expect(mockConnection.commit).not.toHaveBeenCalled();
      });
    });

    test('the allocation never exceeds what the invoice still owes', async () => {
      wire({
        installment: { id: 10, plan_id: 1, sequence: 3, amount: '100.00', invoice_id: 99, status: 'pending' },
        payment: { id: 5, organization_id: 1, client_id: 10, amount: '100.00', status: 'completed' },
        invoice: { id: 99, client_id: 10, total: '300.00', balance_due: '40.00', status: 'issued' },
      });
      await paymentPlanService.payInstallment(1, 3, 5, 1);
      const alloc = mockConnection.execute.mock.calls.find(([sql]) => /INSERT INTO payment_allocations/.test(sql));
      expect(alloc[1]).toEqual([5, 99, 40]);
    });
  });

  // ===========================================================================
  // checkInstallmentsDue
  // ===========================================================================
  describe('checkInstallmentsDue', () => {
    test('calls db.query to mark overdue installments', async () => {
      db.query
        .mockResolvedValueOnce([{ affectedRows: 2 }]) // UPDATE overdue
        .mockResolvedValueOnce([[]])                  // SELECT newly overdue (empty)
        ;

      await paymentPlanService.checkInstallmentsDue();

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'overdue'"),
      );
    });

    test('does not throw when no installments are overdue', async () => {
      db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

      await expect(paymentPlanService.checkInstallmentsDue()).resolves.toBeUndefined();
      // Should only call UPDATE once (no SELECT needed when affectedRows=0)
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('does not write to notification_events — the table does not exist', async () => {
      // This used to INSERT INTO notification_events inside a try/catch. There is
      // no such table in database/schema.sql, so the INSERT threw for every row
      // and the catch swallowed it: the "fallback" log was the only code path that
      // ever ran. The service now logs directly and issues no INSERT.
      const overdueInst = { id: 5, plan_id: 1, sequence: 1, amount: '50.00', due_date: '2025-01-01', client_id: 10, organization_id: 1 };

      db.query
        .mockResolvedValueOnce([{ affectedRows: 1 }])   // UPDATE overdue
        .mockResolvedValueOnce([[overdueInst]]);        // SELECT overdue rows

      await expect(paymentPlanService.checkInstallmentsDue()).resolves.toBeUndefined();

      expect(db.query).toHaveBeenCalledTimes(2);
      const sqlIssued = db.query.mock.calls.map(([sql]) => sql).join('\n');
      expect(sqlIssued).not.toContain('notification_events');
    });
  });

  // ===========================================================================
  // getPlanWithInstallments
  // ===========================================================================
  describe('getPlanWithInstallments', () => {
    test('returns plan with installments array', async () => {
      const plan = { id: 1, organization_id: 1, status: 'active', installment_count: 2 };
      const installments = [
        { id: 1, plan_id: 1, sequence: 1, amount: '50.00', status: 'paid' },
        { id: 2, plan_id: 1, sequence: 2, amount: '50.00', status: 'pending' },
      ];

      db.query
        .mockResolvedValueOnce([[plan]])
        .mockResolvedValueOnce([installments]);

      const result = await paymentPlanService.getPlanWithInstallments(1, 1);

      expect(result.plan).toEqual(plan);
      expect(result.installments).toHaveLength(2);
      expect(result.installments[0].sequence).toBe(1);
      expect(result.installments[1].sequence).toBe(2);
    });

    test('throws NOT_FOUND when plan not found for org', async () => {
      db.query.mockResolvedValueOnce([[]]); // no plan

      await expect(
        paymentPlanService.getPlanWithInstallments(999, 1),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });

    test('queries with correct plan_id and organization_id', async () => {
      db.query.mockResolvedValueOnce([[]]); // triggers throw

      await expect(
        paymentPlanService.getPlanWithInstallments(42, 7),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('organization_id'),
        [42, 7],
      );
    });
  });
});

// BIL-17: the invoice a client is paying in installments is not suspended for
// and does not accrue late fees while the plan is active.
describe('invoices under an active plan', () => {
  const planClause = /NOT EXISTS \(SELECT 1 FROM payment_plan_installments ppi\s+JOIN payment_plans pp ON pp\.id = ppi\.plan_id\s+WHERE ppi\.invoice_id = i\.id AND pp\.status = 'active'/;

  test('suspension skips them, both when choosing and when acting', () => {
    const src = require('fs').readFileSync(require.resolve('../src/services/suspensionService'), 'utf8');
    expect(src.match(/notUnderActivePlanSql\('i'\)/g)).toHaveLength(2);
    expect(require('../src/utils/invoiceBalance').notUnderActivePlanSql('i')).toMatch(planClause);
  });

  test('late fees skip them', async () => {
    const lateFeeService = require('../src/services/lateFeeService');
    db.query
      .mockResolvedValueOnce([[{ id: 1, organization_id: 1, is_active: 1, days_after_due: 1, fee_type: 'fixed', fee_amount: '10.00' }]])
      .mockResolvedValue([[]]);
    await lateFeeService.applyLateFees(1).catch(() => {});
    const overdue = db.query.mock.calls.find(([sql]) => /DATEDIFF\(NOW\(\), i\.due_date\) AS days_overdue/.test(sql));
    expect(overdue[0]).toMatch(planClause);
  });
});
