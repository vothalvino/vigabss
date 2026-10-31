// =============================================================================
// TNB-10 — satisfaction surveys stay with this organization's clients
// =============================================================================
// POST /satisfaction-surveys stored any client_id, the list joined clients
// without an organization predicate (so it showed the other tenant's client
// name), and sendSurvey loaded the client by id alone.
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
const call = (method, path, body) => request(app)[method](`/api/v1${path}`)
  .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1').send(body);

beforeEach(() => {
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    if (/^\s*(INSERT|UPDATE)/.test(sql)) return [{ insertId: 7, affectedRows: 1 }];
    if (/COUNT\(\*\)/.test(sql)) return [[{ total: 0 }]];
    return [[]];
  });
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

test.each([
  [{ client_id: 900 }],
  [{ client_id: 5, ticket_id: 900 }],
  [{ client_id: 5, interaction_id: 900 }],
])('creating a survey with %j from another tenant is refused', async (body) => {
  // Client 5 is this organization's; id 900 is not.
  db.query.mockImplementation(async (sql, params = []) => {
    if (/^\s*INSERT/.test(sql)) return [{ insertId: 7 }];
    if (/^SELECT id FROM \w+ WHERE id = \?/.test(sql)) return [String(params[0]) === '5' ? [{ id: 5 }] : []];
    return [[]];
  });
  const res = await call('post', '/satisfaction-surveys', body);
  expect(res.status).toBe(422);
  expect(db.query.mock.calls.some(([sql]) => /INSERT INTO satisfaction_surveys/.test(sql))).toBe(false);
});

test('the list only joins clients of the survey\'s organization', async () => {
  await call('get', '/satisfaction-surveys');
  const joins = db.query.mock.calls.map(([sql]) => sql).filter(sql => /JOIN clients cl/.test(sql));
  expect(joins.length).toBe(2);
  for (const sql of joins) expect(sql).toMatch(/cl\.organization_id <=> s\.organization_id/);
});

test('sendSurvey reads the client within the survey\'s organization', async () => {
  const SatisfactionSurvey = require('../src/models/SatisfactionSurvey');
  jest.spyOn(SatisfactionSurvey, 'findById').mockResolvedValue({ id: 3, client_id: 900, organization_id: 1, status: 'pending' });
  jest.spyOn(SatisfactionSurvey, 'update').mockResolvedValue({ id: 3, status: 'sent' });
  const { sendSurvey } = require('../src/services/interactionService');
  await sendSurvey(3, 1);
  const read = db.query.mock.calls.find(([sql]) => /FROM clients WHERE id = \?/.test(sql));
  expect(read[0]).toMatch(/organization_id <=> \?/);
  expect(read[1]).toEqual([900, 1]);
});
