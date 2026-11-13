// The Overdue filter of GET /invoices has its own query (overdue is a derived
// state). It ignored order_by / order, so the list's sortable column headers
// did nothing while that filter was on.

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

const db = require('../src/config/database');
const app = require('../src/app');

function listSql() {
  return db.query.mock.calls.map(c => String(c[0])).find(s => /SELECT \* FROM invoices/.test(s));
}

beforeEach(() => {
  db.query.mockReset();
  db.query.mockImplementation(async (sql) =>
    (/COUNT\(\*\)/.test(sql) ? [[{ total: 0 }]] : [[]]));
});

test('default order is longest overdue first', async () => {
  const res = await request(app).get('/api/v1/invoices?status=overdue');
  expect(res.status).toBe(200);
  expect(listSql()).toMatch(/ORDER BY `due_date` ASC, id ASC/);
});

test('order_by and order are honoured', async () => {
  await request(app).get('/api/v1/invoices?status=overdue&order_by=total&order=desc');
  expect(listSql()).toMatch(/ORDER BY `total` DESC, id DESC/);
});

test('an unknown column falls back to due_date and is never interpolated', async () => {
  await request(app).get('/api/v1/invoices?status=overdue&order_by=id;DROP TABLE x&order=sideways');
  const sql = listSql();
  expect(sql).toMatch(/ORDER BY `due_date` ASC, id ASC/);
  expect(sql).not.toMatch(/DROP/);
});
