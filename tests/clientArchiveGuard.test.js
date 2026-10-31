// =============================================================================
// DAL-03 — archiving a client cannot leave its service and billing running
// =============================================================================
// DELETE /clients/:id only set clients.deleted_at: contracts kept their
// service and were still invoiced, autopay still charged the saved card and
// late fees still accrued, while the client was locked out of the portal.
// Archiving is now refused while anything is still open, and the billing jobs
// skip archived clients as defense in depth.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/Client');
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const Client = require('../src/models/Client');
const User = require('../src/models/User');
const app = require('../src/app');

const token = jwt.sign({ sub: 1, email: 'admin@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });

let counts;
beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  counts = { contracts: 0, invoices: 0, recurring_payment_profiles: 0 };
  db.query.mockImplementation(async (sql) => {
    const m = sql.match(/SELECT COUNT\(\*\) AS n FROM (\w+)/);
    if (m) return [[{ n: counts[m[1]] }]];
    return [[]];
  });
  User.findById.mockResolvedValue({ id: 1, email: 'admin@test.com', status: 'active', role: 'admin', organization_id: 1 });
  Client.findByIdOrFail.mockResolvedValue({ id: 10, organization_id: 1, name: 'Alice' });
  Client.delete.mockResolvedValue(true);
});

const archive = () => request(app).delete('/api/v1/clients/10')
  .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1');

test.each([
  ['an active, pending or suspended contract', 'contracts'],
  ['an invoice with a balance due', 'invoices'],
  ['active autopay', 'recurring_payment_profiles'],
])('archiving is refused while the client has %s', async (_label, table) => {
  counts[table] = 1;

  const res = await archive();

  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe('CLIENT_HAS_OPEN_ACCOUNT');
  expect(res.body.error.details.map(d => d.field)).toEqual([table]);
  expect(Client.delete).not.toHaveBeenCalled();
});

test('the checks are bound to the client and the caller organization', async () => {
  counts.contracts = 2;
  await archive();
  const countCalls = db.query.mock.calls.filter(([sql]) => /SELECT COUNT\(\*\) AS n FROM/.test(sql));
  expect(countCalls).toHaveLength(3);
  for (const [sql, params] of countCalls) {
    expect(sql).toContain('organization_id <=> ?');
    expect(sql).toContain('deleted_at IS NULL');
    expect(params).toEqual([10, 1]);
  }
  expect(countCalls[0][0]).toContain("status IN ('pending', 'active', 'suspended')");
});

test('a client with nothing open is archived', async () => {
  const res = await archive();
  expect(res.status).toBeLessThan(300);
  expect(Client.delete).toHaveBeenCalled();
});

describe('billing jobs skip archived clients', () => {
  test('auto-invoicing only bills live clients and contracts', async () => {
    const taskRunner = require('../src/services/taskRunner');
    db.query.mockResolvedValue([[]]);
    await taskRunner.runAutoInvoice(1);
    const sql = db.query.mock.calls.map(c => c[0]).find(s => /FROM contracts c/.test(s) && /JOIN plans p/.test(s));
    expect(sql).toContain('JOIN clients cl ON cl.id = c.client_id AND cl.deleted_at IS NULL');
    expect(sql).toContain('c.deleted_at IS NULL');
  });

  test('late fees are never applied to an archived client', async () => {
    const lateFeeService = require('../src/services/lateFeeService');
    db.query
      .mockResolvedValueOnce([[{ id: 1, organization_id: 1, is_active: 1 }]])
      .mockResolvedValue([[]]);
    await lateFeeService.applyLateFees(1);
    const sql = db.query.mock.calls.map(c => c[0]).find(s => /DATEDIFF\(NOW\(\), i\.due_date\)/.test(s));
    expect(sql).toContain('cl.deleted_at IS NULL');
  });

  test('autopay never charges an archived client', async () => {
    const checkoutService = require('../src/services/checkoutService');
    db.query.mockResolvedValue([[]]);
    await checkoutService.processRecurringCharges(1);
    expect(db.query.mock.calls[0][0]).toContain('JOIN clients cl ON cl.id = rp.client_id AND cl.deleted_at IS NULL');
  });
});
