// =============================================================================
// BIL-16 — cash reconciliation counted nothing
// =============================================================================
// closeSession summed cash payments WHERE recorded_by = agent, but nothing ever
// wrote payments.recorded_by, so expected_total was 0 for every session and the
// variance equalled the counted cash. The window also compared payment_date (a
// DATE, so midnight) with opened_at (a DATETIME), dropping every payment taken
// on the opening day, and it counted deleted and non-completed payments.
// =============================================================================

const request = require('supertest');

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 8, role: 'admin' }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = 5; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const app = require('../src/app');
const cashReconciliationService = require('../src/services/cashReconciliationService');

const STORED = { id: 70, organization_id: 5, client_id: 42, amount: '500.00', currency: 'MXN', status: 'completed', recorded_by: 8 };

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql) => {
    if (/FROM clients/.test(sql)) return [[{ id: 42 }]];
    if (/^\s*INSERT/i.test(sql)) return [{ insertId: 70, affectedRows: 1 }];
    if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM `?payments`?/.test(sql)) return [[STORED]];
    return [[]];
  });
  db.execute.mockImplementation(db.query.getMockImplementation());
});

const paymentInsert = () => db.query.mock.calls.find(([sql]) => /^INSERT INTO `payments`/.test(sql));

describe('payments.recorded_by is the staff member who recorded the payment', () => {
  it('POST /payments stamps the caller', async () => {
    const res = await request(app).post('/api/v1/payments')
      .send({ client_id: 42, amount: 500, currency: 'MXN', payment_method: 'cash' });
    expect(res.status).toBe(201);
    const [sql, params] = paymentInsert();
    const cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map((c) => c.trim().replace(/`/g, ''));
    expect(params[cols.indexOf('recorded_by')]).toBe(8);
  });

  it('POST /payments ignores a recorded_by in the body', async () => {
    await request(app).post('/api/v1/payments')
      .send({ client_id: 42, amount: 500, currency: 'MXN', payment_method: 'cash', recorded_by: 99 });
    const [sql, params] = paymentInsert();
    const cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map((c) => c.trim().replace(/`/g, ''));
    expect(params[cols.indexOf('recorded_by')]).toBe(8);
    expect(params).not.toContain(99);
  });

  it('PATCH /payments/:id cannot move a payment to another cashier', async () => {
    await request(app).patch('/api/v1/payments/70').send({ recorded_by: 99, notes: 'x' });
    const update = db.query.mock.calls.find(([sql]) => /^UPDATE `?payments`?/.test(sql));
    expect(update).toBeTruthy();
    expect(update[0]).not.toMatch(/recorded_by/);
    expect(update[1]).not.toContain(99);
  });

  it('a group payment records the staff member who took it', () => {
    const src = require('fs').readFileSync(require.resolve('../src/services/groupBillingService'), 'utf8');
    const insert = src.slice(src.indexOf('INSERT INTO payments'), src.indexOf('const paymentId = payResult.insertId'));
    expect(insert).toMatch(/recorded_by/);
    expect(insert).toMatch(/opts\.actorUserId/);
  });
});

describe('the session window', () => {
  const OPEN = { id: 3, organization_id: 5, agent_user_id: 8, status: 'open', opened_at: '2026-10-30 09:00:00', closed_at: null };

  function wireSession() {
    db.query.mockImplementation(async (sql) => {
      if (/FROM cash_reconciliation_sessions/.test(sql)) return [[OPEN]];
      if (/AS expected_total/.test(sql)) return [[{ expected_total: '5000.00' }]];
      if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: 1 }];
      return [[]];
    });
  }

  for (const [name, run, re] of [
    ['closeSession', () => cashReconciliationService.closeSession(3, 5, 5000), /AS expected_total/],
    ['getSessionDetail', () => cashReconciliationService.getSessionDetail(3, 5), /SELECT \* FROM payments/],
  ]) {
    it(`${name} matches on created_at and counts only live, completed payments`, async () => {
      wireSession();
      await run();
      const [sql, params] = db.query.mock.calls.find(([q]) => re.test(q));
      expect(sql).toMatch(/created_at BETWEEN \? AND/);
      expect(sql).not.toMatch(/payment_date BETWEEN/);
      expect(sql).toMatch(/status = 'completed'/);
      expect(sql).toMatch(/deleted_at IS NULL/);
      expect(params.slice(0, 3)).toEqual([5, 8, OPEN.opened_at]);
    });
  }

  it('the variance is counted minus the cash the agent recorded', async () => {
    wireSession();
    await cashReconciliationService.closeSession(3, 5, 5000);
    const close = db.query.mock.calls.find(([sql]) => /SET expected_total/.test(sql));
    expect(close[1].slice(0, 3)).toEqual([5000, 5000, 0]);
  });
});
