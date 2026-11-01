// =============================================================================
// GQL-03 — contract add-ons bill by period, by their own cycle, and can stop
// =============================================================================
// generateInvoice added every active add-on to every invoice at
// unit_price × quantity. It ignored the catalog's billing_cycle, so a one-time
// equipment charge and a yearly add-on billed every period, and a monthly
// add-on on a quarterly contract billed one month a quarter. No route could
// change or cancel an add-on, so a mistaken one billed for ever.
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
  orgScope: (req, _res, next) => { req.orgId = 1; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const Organization = require('../src/models/Organization');
const billingService = require('../src/services/billingService');

const PLAN = { id: 7, name: 'Basic', price: '100.00', currency: 'MXN', billing_cycle: 'monthly' };

async function bill(addons, { period = { id: 10, period_start: '2026-10-01', period_end: '2026-10-31' }, contract = {} } = {}) {
  jest.spyOn(Organization, 'getLocale').mockResolvedValue('global');
  const conn = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    query: jest.fn().mockResolvedValue([[{ id: 6 }]]),
    execute: jest.fn(async (sql) => {
      if (/FROM billing_periods/.test(sql)) return [[{ id: 10, status: 'pending' }]];
      if (/tax_exempt/.test(sql)) return [[{ tax_exempt: 0 }]];
      if (/INSERT INTO invoices\b/.test(sql)) return [{ insertId: 50 }];
      if (/FROM contract_addons ca/.test(sql)) return [addons.map((a) => ({ ...a }))];
      if (/^\s*SELECT/.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    }),
  };
  db.getConnection.mockResolvedValue(conn);
  db.query.mockResolvedValue([[{ id: 50 }]]);
  await billingService.generateInvoice(period, { id: 2001, client_id: 3, price_override: null, ...contract }, PLAN, 1);
  const lines = conn.execute.mock.calls
    .filter(([sql]) => /INSERT INTO invoice_items/.test(sql))
    .map(([, p]) => ({ description: p[1], quantity: p[2], unitPrice: p[3], amount: p[4] }));
  return { conn, lines };
}

const addon = (over) => ({ id: 1, addon_name: 'IP Estática', unit_price: '50.00', quantity: 1, start_date: '2026-01-15', end_date: null, addon_cycle: 'monthly', ...over });

beforeEach(() => jest.clearAllMocks());

describe('generateInvoice', () => {
  test('selects add-ons by the billing period and skips deleted catalog entries', async () => {
    const { conn } = await bill([]);
    const [sql, params] = conn.execute.mock.calls.find(([q]) => /FROM contract_addons ca/.test(q));
    expect(sql).toMatch(/pa\.deleted_at IS NULL/);
    expect(sql).toMatch(/ca\.start_date <= \?/);
    expect(sql).toMatch(/ca\.end_date >= \?/);
    expect(params).toEqual([2001, '2026-10-31', '2026-10-01']);
  });

  test('a monthly add-on on a quarterly contract bills three months', async () => {
    const { lines } = await bill([addon()], {
      period: { id: 10, period_start: '2026-10-01', period_end: '2026-12-31' },
      contract: { billing_cycle: 'quarterly' },
    });
    expect(lines[1]).toMatchObject({ description: 'IP Estática (3 months)', unitPrice: 150, amount: 150 });
  });

  test('a monthly add-on on a monthly contract bills one month', async () => {
    const { lines } = await bill([addon({ quantity: 2 })]);
    expect(lines[1]).toMatchObject({ description: 'IP Estática', quantity: 2, unitPrice: 50, amount: 100 });
  });

  test('a yearly add-on bills only in the period holding its anniversary', async () => {
    const yearly = addon({ addon_cycle: 'yearly', start_date: '2025-10-15', unit_price: '600.00' });
    const october = await bill([yearly]);
    expect(october.lines[1]).toMatchObject({ description: 'IP Estática (yearly)', amount: 600 });
    const november = await bill([yearly], { period: { id: 11, period_start: '2026-11-01', period_end: '2026-11-30' } });
    expect(november.lines).toHaveLength(1);
  });

  test('a one-time add-on bills once and is expired in the same transaction', async () => {
    const { conn, lines } = await bill([addon({ id: 7, addon_cycle: 'one_time', unit_price: '1200.00' })]);
    expect(lines[1]).toMatchObject({ amount: 1200 });
    const expire = conn.execute.mock.calls.find(([sql]) => /UPDATE contract_addons SET status = 'expired'/.test(sql));
    expect(expire[1]).toEqual([7]);
    expect(conn.commit).toHaveBeenCalled();
  });

  test('the invoice totals include the scaled add-on', async () => {
    const { conn } = await bill([addon()], {
      period: { id: 10, period_start: '2026-10-01', period_end: '2026-12-31' },
      contract: { billing_cycle: 'quarterly' },
    });
    const totals = conn.execute.mock.calls.find(([sql]) => /UPDATE invoices SET subtotal = \?/.test(sql));
    expect(totals[1][0]).toBe(250);
  });
});

describe('PATCH and cancel /contracts/:id/addons/:addonId', () => {
  const app = require('../src/app');
  const ROW = { id: 900, contract_id: 2001, status: 'active', quantity: 1, unit_price: '50.00', end_date: null, deleted_at: null };

  function wire(row = ROW) {
    db.query.mockImplementation(async (sql) => {
      if (/FROM `?contracts`? WHERE/.test(sql)) return [[{ id: 2001, organization_id: 1 }]];
      if (/FROM contract_addons WHERE id = \? AND contract_id = \?/.test(sql)) return [row ? [{ ...row }] : []];
      if (/SELECT \* FROM contract_addons WHERE id = \?/.test(sql)) return [[{ ...row, status: 'cancelled' }]];
      return [{ affectedRows: 1 }];
    });
  }

  test('PATCH changes the price and end date', async () => {
    wire();
    const res = await request(app).patch('/api/v1/contracts/2001/addons/900').send({ unit_price: 40, end_date: '2026-12-31' });
    expect(res.status).toBe(200);
    const upd = db.query.mock.calls.find(([sql]) => /^UPDATE contract_addons SET/.test(sql));
    expect(upd[0]).toMatch(/unit_price = \?, end_date = \?/);
    expect(upd[1]).toEqual([40, '2026-12-31', 900]);
  });

  test('cancel stops it and caps end_date at today', async () => {
    wire();
    const res = await request(app).post('/api/v1/contracts/2001/addons/900/cancel');
    expect(res.status).toBe(200);
    const upd = db.query.mock.calls.find(([sql]) => /SET status = 'cancelled'/.test(sql));
    expect(upd[0]).toMatch(/end_date = LEAST\(COALESCE\(end_date, CURDATE\(\)\), CURDATE\(\)\)/);
    expect(upd[1]).toEqual([900]);
  });

  test('an add-on of another contract is 404', async () => {
    wire(null);
    const res = await request(app).post('/api/v1/contracts/2001/addons/901/cancel');
    expect(res.status).toBe(404);
  });

  test('a cancelled add-on cannot be edited', async () => {
    wire({ ...ROW, status: 'cancelled' });
    const res = await request(app).patch('/api/v1/contracts/2001/addons/900').send({ unit_price: 40 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ADDON_NOT_ACTIVE');
  });
});
