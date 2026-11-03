'use strict';

// =============================================================================
// FE-26 — portal self-service: payment history without staff notes, and
// ticket comments that say who wrote them
// =============================================================================
// GET /portal/payments returned payments.notes, which staff write for staff.
// A comment the subscriber posted from the portal or chat was stored with no
// author (user_id NULL), exactly like a system message, so staff saw the
// client's reply as written by "System".
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 7, organization_id: 1, role: 'admin' };
    next();
  },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = 1; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/jobQueueService', () => ({ add: jest.fn().mockResolvedValue(null) }));

const request = require('supertest');
const db = require('../src/config/database');
const { signPortalAccessToken } = require('../src/utils/accessTokens');
const app = require('../src/app');

const CLIENT = { id: 10, organization_id: 1, name: 'Alice', email: 'alice@example.com', status: 'active', portal_token_version: 0 };

function route(handlers) {
  db.query.mockImplementation(async (sql, params) => {
    if (/FROM clients WHERE id = \? AND deleted_at IS NULL LIMIT 1/.test(sql)) return [[CLIENT]];
    for (const [pattern, answer] of handlers) {
      if (pattern.test(sql)) return typeof answer === 'function' ? answer(sql, params) : answer;
    }
    return [[]];
  });
}
const calls = re => db.query.mock.calls.filter(([sql]) => re.test(sql));
const portal = (method, path) => request(app)[method](path).set('Authorization', `Bearer ${signPortalAccessToken({ clientId: 10 }, 900)}`);

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
});

test('the portal payment history does not select staff notes', async () => {
  route([
    [/FROM payments p/, [[{ id: 1, amount: '100.00', currency: 'MXN', status: 'completed' }]]],
    [/COUNT\(\*\) AS total FROM payments/, [[{ total: 1 }]]],
  ]);
  const res = await portal('get', '/api/v1/portal/payments');
  expect(res.status).toBe(200);
  const [select] = calls(/FROM payments p/)[0];
  expect(select).not.toMatch(/\bnotes\b/);
});

test('a portal reply is recorded as the client\'s comment', async () => {
  route([
    [/SELECT id, contract_id FROM tickets/, [[{ id: 55, contract_id: null }]]],
    [/INSERT INTO ticket_comments/, [{ insertId: 900 }]],
    [/FROM ticket_comments WHERE id = \?/, [[{ id: 900, ticket_id: 55, author_type: 'client', body: 'Thanks' }]]],
  ]);
  const res = await portal('post', '/api/v1/portal/tickets/55/comments').send({ body: 'Thanks' });
  expect(res.status).toBe(201);
  const [sql, params] = calls(/INSERT INTO ticket_comments/)[0];
  expect(sql).toMatch(/\(ticket_id, author_type, client_id, body, is_internal\) VALUES \(\?, 'client', \?, \?, 0\)/);
  expect(params).toEqual(['55', 10, 'Thanks']);
});

test('the portal thread says who wrote each comment, staff by first name only', async () => {
  route([
    [/FROM tickets\s+WHERE id = \? AND client_id = \?/, [[{ id: 55, subject: 'No signal', status: 'open' }]]],
    [/FROM ticket_comments tc/, [[
      { id: 1, body: 'It is down', author_type: 'client', author_name: 'Alice' },
      { id: 2, body: 'Checking', author_type: 'staff', author_name: 'Bea' },
    ]]],
  ]);
  const res = await portal('get', '/api/v1/portal/tickets/55');
  expect(res.status).toBe(200);
  expect(res.body.data.comments.map(c => c.author_type)).toEqual(['client', 'staff']);
  const [sql] = calls(/FROM ticket_comments tc/)[0];
  expect(sql).toMatch(/WHEN 'staff' THEN u\.first_name/);
  expect(sql).not.toMatch(/last_name|email/);
  expect(sql).toMatch(/tc\.is_internal = 0/);
});

test('staff see the client as the author of a portal reply, and their own replies are staff comments', async () => {
  route([
    [/FROM tickets/, [[{ id: 55, organization_id: 1, client_id: 10 }]]],
    [/FROM ticket_comments tc/, [[{ id: 1, body: 'It is down', author_type: 'client', author_name: 'Alice', first_name: null, last_name: null }]]],
    [/INSERT INTO ticket_comments/, [{ insertId: 901 }]],
    [/FROM ticket_comments WHERE id = \?/, [[{ id: 901, ticket_id: 55, author_type: 'staff' }]]],
  ]);
  const thread = await request(app).get('/api/v1/tickets/55/comments');
  expect(thread.status).toBe(200);
  expect(thread.body.data[0]).toMatchObject({ author_type: 'client', author_name: 'Alice' });
  expect(calls(/FROM ticket_comments tc/)[0][0]).toMatch(/LEFT JOIN clients c ON c\.id = tc\.client_id/);

  const reply = await request(app).post('/api/v1/tickets/55/comments').send({ body: 'On it' });
  expect(reply.status).toBe(201);
  expect(calls(/INSERT INTO ticket_comments/)[0][0]).toMatch(/VALUES \(\?, \?, 'staff', \?, \?\)/);
});
