// =============================================================================
// FE-04 — GET /clients?ids=… returns exactly the clients a list page shows
// =============================================================================
// List pages built id -> name maps from one capped page (the newest 100
// clients), so rows for older clients showed bare ids. They now ask for the
// ids on the page.
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

const token = jwt.sign({ sub: 1, email: 'u@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const list = query => request(app).get('/api/v1/clients').query(query).set('Authorization', `Bearer ${token}`);

beforeEach(() => {
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(sql) ? [[{ total: 2 }]] : [[{ id: 3, name: 'Old client' }, { id: 250, name: 'Another' }]]));
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

const listSql = () => db.query.mock.calls.find(([sql]) => /FROM clients c/.test(sql) && !/COUNT/.test(sql));

test('ids filters to those clients, in the caller organization', async () => {
  const res = await list({ ids: '250,3,3,abc', include_deleted: 'true' });
  expect(res.status).toBe(200);
  const [sql, params] = listSql();
  expect(sql).toMatch(/c\.organization_id = \?/);
  expect(sql).toMatch(/c\.id IN \(\?, \?\)/);
  expect(sql).not.toMatch(/c\.deleted_at IS NULL/); // archived clients still name old documents
  expect(params).toEqual([1, 250, 3]);
});

test('at most 100 ids are looked up', async () => {
  await list({ ids: Array.from({ length: 150 }, (_, i) => i + 1).join(',') });
  const [, params] = listSql();
  expect(params).toHaveLength(1 + 100);
});

test('ids with no valid id returns nothing rather than every client', async () => {
  const res = await list({ ids: 'x,-1,0' });
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual([]);
  expect(listSql()).toBeUndefined();
});
