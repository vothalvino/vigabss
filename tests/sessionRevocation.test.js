// =============================================================================
// SEC-10 — password and account changes end every session
// =============================================================================
// Admin PUT/PATCH /users/:id (password, email, status, group), archive and
// portal password changes left refresh sessions alive, and no path could end
// an access JWT before it expired. Accounts now carry a token version
// (migration 482) embedded in their access tokens and checked per request.
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

const bumped = (table) => db.query.mock.calls.some(([sql]) => new RegExp(`UPDATE ${table} SET (portal_)?token_version = (portal_)?token_version \\+ 1`).test(sql));

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue([{ affectedRows: 1 }]);
});

describe('staff access tokens', () => {
  const app = require('../src/app');
  const tokenWith = (tv) => jwt.sign({ sub: 7, email: 'u@test.com', role: 'admin', orgId: 1, tv }, config.jwt.secret, { expiresIn: '1h' });

  test.each([
    ['an older version', 0, 1],
    ['no version claim after a revocation', undefined, 2],
  ])('%s is refused (401)', async (_l, tv, current) => {
    User.findById.mockResolvedValue({ id: 7, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1, token_version: current });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${tokenWith(tv)}`);
    expect(res.status).toBe(401);
  });

  test('a token with the current version is accepted', async () => {
    User.findById.mockResolvedValue({ id: 7, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1, token_version: 3 });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${tokenWith(3)}`);
    expect(res.status).not.toBe(401);
  });
});

describe('admin changes to a user', () => {
  let options;
  let tunnels;
  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('../src/controllers/crudController', () => ({
        crudController: (_model, opts) => {
          options = opts;
          const noop = (_req, _res, next) => next();
          return { list: noop, get: noop, create: noop, update: noop, partialUpdate: noop, destroy: noop, restore: noop };
        },
      }));
      require('../src/routes/users');
      tunnels = require('../src/services/userTunnelService');
    });
  });

  const OLD = { id: 9, email: 'a@test.com', status: 'active', group_id: 3, role: 'support', password_hash: 'h1', first_name: 'Ana' };
  async function update(changes) {
    const req = { body: { ...changes }, orgId: 1, user: { id: 1 } };
    req._userBeforeUpdate = OLD;
    await options.afterUpdate({ ...OLD, ...changes }, req);
  }

  test.each([
    [{ password_hash: 'h2' }],
    [{ email: 'b@test.com' }],
    [{ status: 'inactive' }],
    [{ group_id: 4 }],
  ])('%j ends the user\'s sessions', async (changes) => {
    await update(changes);
    expect(bumped('users')).toBe(true);
    expect(db.query.mock.calls.some(([sql, p]) => /DELETE FROM user_sessions WHERE user_id = \?/.test(sql) && p[0] === 9)).toBe(true);
  });

  test('an edit that re-sends unchanged fields keeps the sessions', async () => {
    await update({ first_name: 'Anna', email: 'a@test.com', status: 'active' });
    expect(bumped('users')).toBe(false);
  });

  test('archiving ends the user\'s sessions', async () => {
    const revokeTunnels = jest.spyOn(tunnels, 'revokeAllForUser').mockResolvedValue();
    await options.afterDelete(OLD, { user: { id: 1 } });
    expect(bumped('users')).toBe(true);
    expect(revokeTunnels).toHaveBeenCalledWith(9, 1);
    revokeTunnels.mockRestore();
  });
});

describe('portal', () => {
  test('setting a portal password ends every portal session', async () => {
    const portalAuthService = require('../src/services/portalAuthService');
    await portalAuthService.setPassword(5, 'a-new-portal-pw');
    expect(bumped('clients')).toBe(true);
    expect(db.query.mock.calls.some(([sql, p]) => /UPDATE portal_refresh_tokens SET revoked_at = NOW\(\) WHERE client_id = \?/.test(sql) && p[0] === 5)).toBe(true);
  });

  test('a portal access token from before the change is refused', async () => {
    const app = require('../src/app');
    const { signPortalAccessToken } = require('../src/utils/accessTokens');
    const token = signPortalAccessToken({ clientId: 5, organizationId: 1, tokenVersion: 0 }, 900);
    db.query.mockImplementation(async (sql) => (/FROM clients WHERE id = \?/.test(sql)
      ? [[{ id: 5, organization_id: 1, name: 'C', email: 'c@test.com', status: 'active', portal_token_version: 1 }]]
      : [[]]));
    const res = await request(app).get('/api/v1/portal/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
