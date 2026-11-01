// =============================================================================
// ASY-16 — automation runs report what happened
// =============================================================================
// dispatchAction did nothing for any action type but returned messages such
// as "Ticket creation enqueued (stub)" or "Alert rule updated"; the execution
// was stored as 'success' and run_count/last_triggered_at were bumped. A
// manual run of one rule ran every enabled rule on the same trigger event.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin', organizationId: 1 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const db = require('../src/config/database');
const automationService = require('../src/services/automationService');

const RULES = [
  { id: 3, organization_id: 1, trigger_event: 'payment.received', action_type: 'create_ticket', trigger_conditions: [], action_config: {} },
  { id: 4, organization_id: 1, trigger_event: 'payment.received', action_type: 'suspend_contract', trigger_conditions: [], action_config: {} },
];

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql, params = []) => {
    if (/SELECT \* FROM automation_rules\s+WHERE organization_id = \? AND trigger_event = \?/.test(sql)) {
      return [/AND id = \?/.test(sql) ? RULES.filter((r) => r.id === params[2]) : RULES];
    }
    if (/SELECT \* FROM automation_rules WHERE id = \?/.test(sql)) return [RULES.filter((r) => r.id === Number(params[0]))];
    return [{ affectedRows: 1, insertId: 1 }];
  });
});

const executions = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO automation_rule_executions/.test(sql));

test.each(['send_notification', 'create_ticket', 'run_script', 'set_alert', 'suspend_contract', 'anything_else'])(
  "a '%s' action is recorded as skipped, not as a successful run",
  async (actionType) => {
    db.query.mockImplementation(async (sql) => (/FROM automation_rules/.test(sql)
      ? [[{ ...RULES[0], action_type: actionType }]]
      : [{ affectedRows: 1 }]));
    const result = await automationService.evaluateAutomationRules(1, 'payment.received', {});
    expect(result).toMatchObject({ evaluated: 1, triggered: 0 });
    expect(result.results[0]).toMatchObject({ status: 'skipped', message: expect.stringMatching(/not implemented/) });
    const [, params] = executions()[0];
    expect(params[4]).toBe('skipped');
    expect(db.query.mock.calls.some(([sql]) => /run_count = run_count \+ 1/.test(sql))).toBe(false);
  },
);

test('POST /automation-rules/:id/execute runs only that rule and returns its outcome', async () => {
  const app = require('../src/app');
  const res = await request(app).post('/api/v1/automation-rules/3/execute').send({});
  expect(res.status).toBe(200);
  expect(res.body.data.result.evaluated).toBe(1);
  expect(res.body.data.result.results).toEqual([expect.objectContaining({ rule_id: 3, status: 'skipped' })]);
  expect(executions().map(([, p]) => p[1])).toEqual([3]);
});
