// =============================================================================
// BIL-11 — suspension rules act on overdue, unpaid invoices as configured
// =============================================================================
// evaluateRules matched DATEDIFF >= days_past_due AND < days_past_due + grace,
// so with the default grace of 0 no day could ever match and a rule saved with
// defaults never suspended anyone; with grace N it fired only on N days.
// apply_to_plan_ids was never read, 'notify_only' and 'auto_disconnect' did
// nothing, and the scheduled run counted skipped suspensions as done.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/models/SuspensionRule');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const SuspensionRule = require('../src/models/SuspensionRule');
const suspensionService = require('../src/services/suspensionService');

const rule = (over = {}) => ({
  id: 1, organization_id: 1, days_past_due: 30, grace_period_days: 0,
  action: 'auto_suspend', apply_to_plan_ids: null, is_active: 1, ...over,
});

function routeDb({ rules, contractsByMinDays = {} }) {
  db.query.mockImplementation(async (sql, params) => {
    if (/FROM suspension_rules/.test(sql)) return [rules];
    if (/FROM contracts c/.test(sql)) {
      const minDays = params[2];
      return [contractsByMinDays[minDays] || []];
    }
    return [[]];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
});

describe('evaluateRules', () => {
  test('a rule with the default grace of 0 acts from days_past_due on, with no upper bound', async () => {
    routeDb({ rules: [rule()], contractsByMinDays: { 30: [{ id: 7, invoice_id: 70, days_overdue: 95 }] } });

    const results = await suspensionService.evaluateRules(1);

    expect(results).toHaveLength(1);
    const [sql, params] = db.query.mock.calls.find(([q]) => /FROM contracts c/.test(q));
    expect(params.slice(0, 3)).toEqual([1, 1, 30]);
    expect(sql).toContain('DATEDIFF(NOW(), i.due_date) >= ?');
    expect(sql).not.toMatch(/DATEDIFF\(NOW\(\), i\.due_date\) < \?/);
  });

  test('grace_period_days is extra waiting time added to days_past_due', async () => {
    routeDb({ rules: [rule({ grace_period_days: 5 })] });
    await suspensionService.evaluateRules(1);
    const [, params] = db.query.mock.calls.find(([q]) => /FROM contracts c/.test(q));
    expect(params[2]).toBe(35);
  });

  test('only live, payable invoices with money owed count, and archived or exempt clients never match', async () => {
    routeDb({ rules: [rule()] });
    await suspensionService.evaluateRules(1);
    const [sql] = db.query.mock.calls.find(([q]) => /FROM contracts c/.test(q));
    expect(sql).toContain('i.deleted_at IS NULL');
    expect(sql).toContain("i.status IN ('issued', 'sent', 'overdue')");
    expect(sql).toContain('SUM(pa.amount) FROM payment_allocations pa');
    expect(sql).toContain('cl.deleted_at IS NULL');
    expect(sql).toContain('COALESCE(cl.suspension_exempt, 0) = 0');
    expect(sql).toContain('c.deleted_at IS NULL');
  });

  test('apply_to_plan_ids limits a rule to those plans', async () => {
    routeDb({ rules: [rule({ apply_to_plan_ids: '[4, 9]' })] });
    await suspensionService.evaluateRules(1);
    const [sql, params] = db.query.mock.calls.find(([q]) => /FROM contracts c/.test(q));
    expect(sql).toContain('AND c.plan_id IN (?, ?)');
    expect(params.slice(-2)).toEqual([4, 9]);
  });

  test.each(['notify_only', 'auto_disconnect'])('a stored %s rule is skipped, never acted on', async (action) => {
    routeDb({ rules: [rule({ action })], contractsByMinDays: { 30: [{ id: 7 }] } });
    const results = await suspensionService.evaluateRules(1);
    expect(results).toEqual([]);
    expect(db.query.mock.calls.some(([q]) => /FROM contracts c/.test(q))).toBe(false);
  });

  test('a contract matched by two rules is acted on once, by the stricter rule', async () => {
    const r30 = rule({ id: 1, days_past_due: 30, action: 'soft_suspend' });
    const r60 = rule({ id: 2, days_past_due: 60, action: 'auto_suspend' });
    routeDb({
      rules: [r60, r30],
      contractsByMinDays: { 30: [{ id: 7 }, { id: 8 }], 60: [{ id: 7 }] },
    });

    const results = await suspensionService.evaluateRules(1);

    expect(results.map(r => [r.contract.id, r.rule.id]).sort()).toEqual([[7, 2], [8, 1]]);
  });
});

describe('suspendContract re-checks under a lock', () => {
  function connWith(answers) {
    const conn = {
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      execute: jest.fn(async (sql) => {
        for (const [re, rows] of answers) if (re.test(sql)) return [rows];
        return [{ affectedRows: 1 }];
      }),
    };
    db.getConnection.mockResolvedValue(conn);
    return conn;
  }

  beforeEach(() => {
    db.query.mockResolvedValue([[{ suspension_exempt: 0 }]]); // not exempt
  });

  test('a contract that is no longer active is not suspended', async () => {
    const conn = connWith([[/FROM contracts WHERE id = \? AND deleted_at IS NULL FOR UPDATE/, [{ id: 7, status: 'suspended' }]]]);

    const outcome = await suspensionService.suspendContract(7, 1, null, 70);

    expect(outcome).toEqual({ skipped: true, reason: 'CONTRACT_NOT_ACTIVE' });
    expect(conn.execute.mock.calls.some(([q]) => /UPDATE contracts SET status/.test(q))).toBe(false);
    expect(conn.rollback).toHaveBeenCalled();
  });

  test('a rule does not suspend once the overdue invoice has been paid', async () => {
    const conn = connWith([
      [/FOR UPDATE/, [{ id: 7, status: 'active' }]],
      [/FROM invoices i/, []],
    ]);

    const outcome = await suspensionService.suspendContract(7, 1, null, 70);

    expect(outcome).toEqual({ skipped: true, reason: 'NO_OVERDUE_BALANCE' });
    expect(conn.execute.mock.calls.some(([q]) => /UPDATE contracts SET status/.test(q))).toBe(false);
  });
});

describe('runAutoSuspend', () => {
  test('a skipped suspension is not counted as suspended', async () => {
    const taskRunner = require('../src/services/taskRunner');
    db.query.mockImplementation(async (sql) => {
      if (/FROM organizations WHERE status/.test(sql)) return [[{ id: 1 }]];
      return [[]];
    });
    jest.spyOn(suspensionService, 'evaluateRules').mockResolvedValue([{ rule: rule(), contract: { id: 7, invoice_id: 70, client_id: 3 } }]);
    jest.spyOn(suspensionService, 'suspendContract').mockResolvedValue({ skipped: true, reason: 'NO_OVERDUE_BALANCE' });

    const result = await taskRunner.runAutoSuspend(1);

    expect(result.contracts_suspended).toBe(0);
  });
});

describe('suspension rule validation', () => {
  const app = require('../src/app');
  const token = jwt.sign({ sub: 1, email: 'admin@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
  const post = body => request(app).post('/api/v1/suspension-rules')
    .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1').send(body);

  beforeEach(() => {
    User.findById.mockResolvedValue({ id: 1, email: 'admin@test.com', status: 'active', role: 'admin', organization_id: 1 });
    SuspensionRule.create.mockImplementation(async data => ({ id: 1, ...data }));
  });

  test.each(['notify_only', 'auto_disconnect'])('the never-enforced %s action is refused', async (action) => {
    const res = await post({ name: 'R', days_past_due: 30, action });
    expect(res.status).toBe(422);
    expect(SuspensionRule.create).not.toHaveBeenCalled();
  });

  test('walled_garden (migration 227) is accepted', async () => {
    const res = await post({ name: 'R', days_past_due: 30, action: 'walled_garden' });
    expect(res.status).toBe(201);
  });

  test('apply_to_plan_ids must name plans of this organization', async () => {
    db.query.mockResolvedValue([[{ n: 1 }]]); // only one of the two plans is ours
    const res = await post({ name: 'R', days_past_due: 30, action: 'auto_suspend', apply_to_plan_ids: [4, 99] });
    expect(res.status).toBe(422);
    expect(SuspensionRule.create).not.toHaveBeenCalled();
    const [sql, params] = db.query.mock.calls.find(([q]) => /FROM plans/.test(q));
    expect(sql).toContain('organization_id <=> ?');
    expect(params).toEqual([4, 99, 1]);
  });

  test('a valid plan list is stored as JSON', async () => {
    db.query.mockResolvedValue([[{ n: 2 }]]);
    const res = await post({ name: 'R', days_past_due: 30, action: 'auto_suspend', apply_to_plan_ids: [4, 9, 4] });
    expect(res.status).toBe(201);
    expect(SuspensionRule.create.mock.calls[0][0].apply_to_plan_ids).toBe('[4,9]');
  });
});
