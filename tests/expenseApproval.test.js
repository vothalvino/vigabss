// =============================================================================
// TNA-28 — expense approval is enforced
// =============================================================================
// createExpense and updateExpense accepted status 'approved', the creator could
// set any user_id, and no route checked expenses.approve. Approval is now its
// own step: create files a pending expense under the caller, edits never touch
// the status, and approve/reject need expenses.approve and a different person.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const app = require('../src/app');

const tokenFor = (id) => jwt.sign({ sub: id, email: `u${id}@test.com`, role: 'technician', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const call = (method, path, body, id = 3) => request(app)[method](`/api/v1${path}`)
  .set('Authorization', `Bearer ${tokenFor(id)}`).set('X-Org-Id', '1').send(body);

let pending;
beforeEach(() => {
  db.query.mockReset();
  pending = { id: 50, organization_id: 1, user_id: 3, status: 'pending', amount: '120.00' };
  db.query.mockImplementation(async (sql) => {
    if (/^\s*INSERT/.test(sql)) return [{ insertId: 50, affectedRows: 1 }];
    if (/^\s*UPDATE/.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM `?expenses`?/.test(sql)) return [[pending]];
    return [[]];
  });
  User.findById.mockImplementation(async (id) => ({ id: Number(id), email: `u${id}@test.com`, status: 'active', role: 'technician', organization_id: 1 }));
  User.getPermissions.mockResolvedValue(['expenses.view', 'expenses.create', 'expenses.update']);
});
const writes = () => db.query.mock.calls.filter(([sql]) => /^\s*(INSERT INTO|UPDATE) `?expenses`?/.test(sql));

test('a new expense is pending and belongs to its creator, whatever the body says', async () => {
  const res = await call('post', '/expenses', { category: 'fuel', amount: 120, expense_date: '2026-10-30', status: 'approved', user_id: 99 });
  expect(res.status).toBe(201);
  const [[sql, params]] = writes();
  expect(sql).toMatch(/INSERT INTO/);
  expect(params).toContain('pending');
  expect(params).toContain(3);
  expect(params).not.toContain('approved');
  expect(params).not.toContain(99);
});

test('an edit cannot change the status', async () => {
  const res = await call('put', '/expenses/50', { notes: 'x', status: 'approved' });
  expect(res.status).toBe(200);
  for (const [sql, params] of writes()) {
    expect(sql).not.toMatch(/`?status`? = /);
    expect(params).not.toContain('approved');
  }
});

test('approve needs expenses.approve', async () => {
  const res = await call('post', '/expenses/50/approve', {}, 4);
  expect(res.status).toBe(403);
  expect(writes()).toHaveLength(0);
});

test('an approver cannot approve their own expense', async () => {
  User.getPermissions.mockResolvedValue(['expenses.view', 'expenses.approve']);
  const res = await call('post', '/expenses/50/approve', {}, 3);
  expect(res.status).toBe(403);
  expect(writes()).toHaveLength(0);
});

test.each([['approve', 'approved'], ['reject', 'rejected']])('%s records the decision and the approver', async (action, status) => {
  User.getPermissions.mockResolvedValue(['expenses.view', 'expenses.approve']);
  const res = await call('post', `/expenses/50/${action}`, {}, 4);
  expect(res.status).toBe(200);
  const [[sql, params]] = writes();
  expect(sql).toMatch(/status = \?, approved_by = \?.*status = 'pending'/s);
  expect(params).toEqual([status, 4, '50', 1]);
});

test('an expense that is no longer pending cannot be decided again', async () => {
  User.getPermissions.mockResolvedValue(['expenses.view', 'expenses.approve']);
  pending.status = 'approved';
  const res = await call('post', '/expenses/50/reject', {}, 4);
  expect(res.status).toBe(422);
  expect(writes()).toHaveLength(0);
});
