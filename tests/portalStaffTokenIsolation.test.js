// =============================================================================
// VigaBSS 5.0 — Portal / staff access-token isolation
// =============================================================================
// A subscriber-portal access token must never authenticate a staff surface.
// Before the fix, authenticate() verified any JWT signed with JWT_SECRET and
// resolved payload.sub as users.id, so a client whose clients.id collided with
// a staff users.id became that staff user. The database mock below answers
// every users lookup with an active admin to model exactly that collision.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

// Model the worst case: the colliding staff user resolves to a global-access
// installation operator, so any request that reaches principal resolution
// would be fully authorized.
jest.mock('../src/services/orgPrincipalService', () => ({
  resolveOrgPrincipal: jest.fn(async (_user, organizationId) => ({
    authorizationRole: 'admin',
    membershipRole: 'admin',
    organizationId: Number(organizationId) || 1,
    isInstallOperator: true,
    isSuperAdmin: true,
    hasGlobalOrganizationAccess: true,
  })),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const { signPortalAccessToken, verifyStaffAccessToken, verifyPortalAccessToken } = require('../src/utils/accessTokens');
const app = require('../src/app');

const COLLIDING_ID = 7;
const STAFF_ADMIN = {
  id: COLLIDING_ID, email: 'admin@isp.example', role: 'admin', status: 'active',
  organization_id: 1, is_install_operator: 1,
};
const CLIENT = { id: COLLIDING_ID, organization_id: 1, name: 'Alice', email: 'alice@example.com', status: 'active' };

const currentPortalToken = () => signPortalAccessToken({ clientId: COLLIDING_ID, organizationId: 1 }, 900);
const legacyPortalToken = () => jwt.sign(
  { sub: COLLIDING_ID, orgId: 1, type: 'portal' },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);
const staffToken = () => jwt.sign(
  { sub: COLLIDING_ID, email: STAFF_ADMIN.email, role: 'admin', orgId: 1 },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);

const usersQueried = () => db.query.mock.calls.some(([sql]) => /FROM `?users`?\b/.test(sql));

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql) => {
    if (/FROM `?users`?\b/.test(sql)) return [[STAFF_ADMIN]];
    if (/FROM clients WHERE id = \?/.test(sql)) return [[CLIENT]];
    return [[]];
  });
});

describe.each([
  ['current portal token', currentPortalToken],
  ['legacy portal token signed with JWT_SECRET', legacyPortalToken],
])('%s on staff surfaces', (_label, makeToken) => {
  test('GET /api/v1/auth/me (Bearer) is 401 and never resolves a staff user', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(401);
    expect(usersQueried()).toBe(false);
  });

  test('GET /api/v1/auth/me (access cookie) is 401', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', `fireisp_access=${makeToken()}`);
    expect(res.status).toBe(401);
    expect(usersQueried()).toBe(false);
  });

  test('POST /api/v1/graphql is 401', async () => {
    const res = await request(app)
      .post('/api/v1/graphql')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ query: '{ __typename }' });
    expect(res.status).toBe(401);
    expect(usersQueried()).toBe(false);
  });

  test('GET /api/v1/events/stream is 401', async () => {
    const res = await request(app).get('/api/v1/events/stream').set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(401);
    expect(usersQueried()).toBe(false);
  });
});

describe('control: a staff token on the same mocks', () => {
  test('GET /api/v1/auth/me succeeds, proving the 401s above come from token separation', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${staffToken()}`);
    expect(res.status).toBe(200);
  });
});

describe('portal surface', () => {
  test('a staff token is rejected by portal authentication', async () => {
    const res = await request(app).get('/api/v1/portal/dashboard').set('Authorization', `Bearer ${staffToken()}`);
    expect(res.status).toBe(401);
  });

  test('a legacy portal token signed with JWT_SECRET is rejected (client must refresh)', async () => {
    const res = await request(app).get('/api/v1/portal/dashboard').set('Authorization', `Bearer ${legacyPortalToken()}`);
    expect(res.status).toBe(401);
  });

  test('a current portal token passes portal authentication', async () => {
    const res = await request(app).get('/api/v1/portal/dashboard').set('Authorization', `Bearer ${currentPortalToken()}`);
    expect(res.status).not.toBe(401);
    expect(db.query.mock.calls.some(([sql]) => /FROM clients WHERE id = \?/.test(sql))).toBe(true);
  });
});

describe('accessTokens helpers', () => {
  test('staff verification rejects any token claiming the portal audience', () => {
    const token = jwt.sign(
      { sub: 1, orgId: 1 },
      config.jwt.secret,
      { expiresIn: 60, algorithm: config.jwt.algorithm, audience: 'vigabss-portal' },
    );
    expect(() => verifyStaffAccessToken(token)).toThrow();
  });

  test('portal verification rejects a staff token', () => {
    expect(() => verifyPortalAccessToken(staffToken())).toThrow();
  });

  test('round-trips a portal token', () => {
    const payload = verifyPortalAccessToken(currentPortalToken());
    expect(payload).toMatchObject({ sub: COLLIDING_ID, orgId: 1, type: 'portal', aud: 'vigabss-portal' });
  });
});
