// =============================================================================
// WHK-10 — staff are warned when a portal email is shared
// =============================================================================
// Portal login now picks the account by password when several clients share
// an email, so two accounts with the same password stay ambiguous. Setting a
// portal password on a shared email says so.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(),
  getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const app = require('../src/app');

const token = jwt.sign({ sub: 1, email: 'a@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const put = () => request(app).put('/api/v1/clients/9/portal-password')
  .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1').send({ password: 'a-portal-password' });

function wire(othersWithSameEmail) {
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    if (/COUNT\(\*\) AS n FROM clients c/.test(sql)) return [[{ n: othersWithSameEmail }]];
    if (/^SELECT id FROM clients WHERE id = \?/.test(sql)) return [[{ id: 9 }]];
    return [{ affectedRows: 1 }];
  });
  User.findById.mockResolvedValue({ id: 1, email: 'a@test.com', status: 'active', role: 'admin', organization_id: 1 });
  User.getPermissions.mockResolvedValue(['clients.update']);
}

test('a shared email returns a warning with the count', async () => {
  wire(2);
  const res = await put();
  expect(res.status).toBe(200);
  expect(res.body.warning).toMatch(/2 other portal account/);
});

test('a unique email returns no warning', async () => {
  wire(0);
  const res = await put();
  expect(res.status).toBe(200);
  expect(res.body.warning).toBeUndefined();
});
