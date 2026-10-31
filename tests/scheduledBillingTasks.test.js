// =============================================================================
// BIL-13 / ASY-02 — scheduled invoicing and install-wide tasks do real work
// =============================================================================
// BIL-13: scheduled and bulk invoicing passed generateInvoice only
// {name, price, currency}, so trials were billed at full price and data
// overage was never charged; the first period started at the order date
// instead of activation; and every per-contract error was swallowed.
// ASY-02: seeded install-wide task rows (organization_id NULL) ran handlers
// that bind `organization_id = ?`, so late fees, reminders, geofences,
// anomaly/churn/remediation and the AI rollup did nothing (the rollup failed).
// Late fees are bounded to one per rule, invoice and month before they start
// running for real.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

const db = require('../src/config/database');
const billingService = require('../src/services/billingService');
const lateFeeService = require('../src/services/lateFeeService');
const taskRunner = require('../src/services/taskRunner');
const { forEachActiveOrganization } = require('../src/services/organizationFanOut');

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  db.query.mockReset();
  db.getConnection.mockReset();
});

describe('generateBillingPeriod', () => {
  test('the first period starts when service was activated, not at the order date', async () => {
    db.query
      .mockResolvedValueOnce([[]]) // no pending period
      .mockResolvedValueOnce([[]]) // no invoiced period
      .mockResolvedValueOnce([{ insertId: 9 }])
      .mockResolvedValueOnce([[{ id: 9 }]]);

    await billingService.generateBillingPeriod({
      id: 1, start_date: new Date(2026, 0, 2), first_activated_at: new Date(2026, 0, 20, 15, 30), billing_day: 1,
    });

    const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO billing_periods/.test(sql));
    const periodStart = insert[1][1];
    expect([periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate()]).toEqual([2026, 0, 20]);
    expect(periodStart.getHours()).toBe(0);
  });
});

describe('generateInvoice loads the full plan', () => {
  function stubInvoiceWrites() {
    const conn = {
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      execute: jest.fn(async (sql) => {
        if (/FROM billing_periods WHERE id = \? FOR UPDATE/.test(sql)) return [[{ id: 3, status: 'pending' }]];
        return [{ insertId: 77, affectedRows: 1 }];
      }),
      query: jest.fn(async () => [[{ id: 1 }]]), // invoice number sequence
    };
    db.getConnection.mockResolvedValue(conn);
    return conn;
  }

  test('a partial plan is replaced by the plan row, so trial pricing applies', async () => {
    const conn = stubInvoiceWrites();
    const fullPlan = {
      id: 5, organization_id: 1, name: 'Fibra 100', price: '500.00', currency: 'MXN',
      trial_days: 30, trial_price: '0.00', overage_mode: 'none', overage_price_per_gb: null,
    };
    db.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM plans WHERE id = \?/.test(sql)) return [[fullPlan]];
      return [[]];
    });

    await billingService.generateInvoice(
      { id: 3, period_start: '2026-10-01', period_end: '2026-10-31' },
      { id: 1, organization_id: 1, client_id: 2, plan_id: 5, first_activated_at: new Date(), start_date: new Date() },
      { name: 'Fibra 100', price: '500.00', currency: 'MXN' },
      1,
    ).catch(() => {}); // later writes are not modelled; only the plan lookup and the price matter

    const [planSql, planParams] = db.query.mock.calls.find(([sql]) => /FROM plans/.test(sql));
    expect(planSql).toContain('organization_id <=> ?');
    expect(planParams).toEqual([5, 1]);
    const itemInsert = conn.execute.mock.calls.find(([sql]) => /INSERT INTO invoice_items/.test(sql));
    expect(itemInsert).toBeDefined();
    expect(itemInsert[1]).toContain(0); // trial price, not 500
  });
});

describe('runAutoInvoice', () => {
  test('a failing contract is logged, counted and reported; the others still run', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, organization_id: 1 }, { id: 2, organization_id: 1 }]]);
    jest.spyOn(billingService, 'generateBillingPeriod')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 9, status: 'invoiced' });

    const result = await taskRunner.runAutoInvoice(1);

    expect(result.contracts_failed).toBe(1);
    expect(result.errors).toEqual([{ contract_id: 1, error: 'boom' }]);
    expect(billingService.generateBillingPeriod).toHaveBeenCalledTimes(2);
  });

  test('the scheduled task is marked failed when any contract failed', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM contracts c/.test(sql)) return [[{ id: 1, organization_id: 1 }]];
      return [[]];
    });
    jest.spyOn(billingService, 'generateBillingPeriod').mockRejectedValue(new Error('boom'));

    await expect(taskRunner.runTask('auto_generate_invoices', 1))
      .rejects.toThrow('Invoice generation failed for 1 of 1 contract(s)');
  });
});

describe('install-wide tasks run for every active organization', () => {
  test('forEachActiveOrganization runs the handler per org and isolates failures', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, database_scope: 'shared' }, { id: 2, database_scope: 'shared' }]]);
    const handler = jest.fn(async (orgId) => {
      if (orgId === 1) throw new Error('org 1 broke');
      return { ok: orgId };
    });

    const summary = await forEachActiveOrganization('t', handler);

    expect(handler.mock.calls.map(c => c[0])).toEqual([1, 2]);
    expect(summary.organizations_failed).toBe(1);
    expect(summary.results).toEqual([{ organization_id: 2, result: { ok: 2 } }]);
  });

  test('forEachActiveOrganization fails the run when every org failed', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, database_scope: 'shared' }]]);
    await expect(forEachActiveOrganization('t', async () => { throw new Error('x'); }))
      .rejects.toThrow('t failed for every active organization');
  });

  test.each([
    ['apply_late_fees', () => jest.spyOn(lateFeeService, 'applyLateFees')],
    ['ai_support_metrics_rollup', () => jest.spyOn(require('../src/services/aiSupportMetricsService'), 'rollupMetrics')],
  ])('%s with no org runs once per active org, never with a NULL org', async (taskName, spyOn) => {
    const spy = spyOn().mockResolvedValue({});
    db.query.mockResolvedValueOnce([[{ id: 4, database_scope: 'shared' }, { id: 7, database_scope: 'shared' }]]);

    await taskRunner.runTask(taskName, null);

    expect(spy.mock.calls.map(c => c[0])).toEqual([4, 7]);
  });

  test('with an org, the handler runs for that org only', async () => {
    const spy = jest.spyOn(lateFeeService, 'applyLateFees').mockResolvedValue({});
    await taskRunner.runTask('apply_late_fees', 9);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(9);
  });
});

describe('late fees are bounded once they run for real', () => {
  const rule = { id: 3, name: 'Late', fee_type: 'percent', fee_amount: '10', grace_period_days: 0, max_applications: null };
  const invoice = { id: 50, subtotal: '120.00', tax_amount: '0', total: '120.00', tax_rate: 0, days_overdue: 20 };

  function wire({ thisPeriod = 0, priorFees = '0', dup = false } = {}) {
    const conn = {
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      execute: jest.fn(async (sql) => {
        if (/INSERT INTO invoice_late_fees/.test(sql)) {
          if (dup) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', errno: 1062 });
          return [{ insertId: 11 }];
        }
        return [{ insertId: 12, affectedRows: 1 }];
      }),
    };
    db.getConnection.mockResolvedValue(conn);
    db.query.mockImplementation(async (sql) => {
      if (/FROM late_fee_rules/.test(sql)) return [[rule]];
      if (/DATEDIFF\(NOW\(\), i\.due_date\)/.test(sql)) return [[{ ...invoice }]];
      if (/COUNT\(\*\) AS cnt/.test(sql)) return [[{ cnt: thisPeriod, this_period: thisPeriod }]];
      if (/SUM\(amount\), 0\) AS fees/.test(sql)) return [[{ fees: priorFees }]];
      return [[]];
    });
    return conn;
  }

  test('an "unlimited" rule does not apply twice in the same month', async () => {
    const conn = wire({ thisPeriod: 1 });
    const result = await lateFeeService.applyLateFees(1);
    expect(result.fees_applied).toBe(0);
    expect(conn.execute).not.toHaveBeenCalled();
  });

  test('the month is claimed through the unique key first; a concurrent run adds nothing', async () => {
    const conn = wire({ dup: true });
    const result = await lateFeeService.applyLateFees(1);
    expect(result.fees_applied).toBe(0);
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.execute.mock.calls.some(([sql]) => /INSERT INTO invoice_items/.test(sql))).toBe(false);
    const [, params] = conn.execute.mock.calls[0];
    expect(params[params.length - 1]).toMatch(/^\d{4}-\d{2}$/);
  });

  test('a percent fee is based on the subtotal without earlier late fees, so it does not compound', async () => {
    const conn = wire({ priorFees: '20.00' });
    const result = await lateFeeService.applyLateFees(1);
    expect(result.fees_applied).toBe(1);
    const [, params] = conn.execute.mock.calls.find(([sql]) => /INSERT INTO invoice_late_fees/.test(sql));
    expect(params[3]).toBe(10); // 10% of (120 - 20), not 12
    expect(conn.commit).toHaveBeenCalled();
  });
});
