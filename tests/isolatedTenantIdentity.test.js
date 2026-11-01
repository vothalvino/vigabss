// =============================================================================
// DB-07 / GQL-01 — staff identity is read and written in the primary database
// =============================================================================
// orgScope runs staff requests inside the organization's tenant context, so for
// an isolated organization every db.query goes to its own database. Users,
// groups and memberships live in the primary (auth and RBAC read them there),
// but /users, /roles and the User identity helpers wrote and read the tenant
// copy: a created user could never log in, group edits were ignored, and
// assignee pickers and staff notifications came back empty. GraphQL resolved
// permissions in the tenant database too, so non-admin staff got FORBIDDEN.
// =============================================================================

const { AsyncLocalStorage } = require('async_hooks');

const mockScope = new AsyncLocalStorage();
const mockQueries = [];

jest.mock('../src/config/database', () => ({
  query: jest.fn(async (sql, params = []) => {
    mockQueries.push({ where: mockScope.getStore() || 'primary', sql, params });
    if (/COUNT\(\*\)/.test(sql)) return [[{ total: 0, cnt: 0 }]];
    if (/^\s*INSERT/i.test(sql)) return [{ insertId: 41, affectedRows: 1 }];
    if (/FROM `?users`? WHERE id = \?/.test(sql)) return [[{ id: 41, organization_id: 7, role: 'support', email: 'a@b.c' }]];
    return [[]];
  }),
  getConnection: jest.fn(),
  withTenantContext: jest.fn((orgId, fn) => mockScope.run(`tenant${orgId}`, fn)),
  withPrimaryContext: jest.fn((fn) => mockScope.run('primary', fn)),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin', organizationId: 7 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => {
    req.orgId = 7;
    require('../src/config/database').withTenantContext(7, () => next());
  },
}));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const db = require('../src/config/database');
const User = require('../src/models/User');

beforeEach(() => { mockQueries.length = 0; });

const placesOf = () => [...new Set(mockQueries.map((q) => q.where))];

describe('User identity helpers called from a tenant request', () => {
  test.each([
    ['getUsersWithPermission', () => User.getUsersWithPermission(7, 'work_orders.update')],
    ['getStaffByEffectiveRole', () => User.getStaffByEffectiveRole(7, ['admin'])],
    ['hasEffectivePermission', () => User.hasEffectivePermission(5, 7, 'tickets.update')],
    ['getOrgRole', () => User.getOrgRole(5, 7)],
    ['setUserOrganizations', () => User.setUserOrganizations(5, [7], 'support')],
    ['countOtherAdminKindUsers', () => User.countOtherAdminKindUsers(7, 5)],
    ['create', () => User.create({ organization_id: 7, email: 'a@b.c', role: 'billing', password_hash: 'x' })],
  ])('%s queries the primary database', async (_name, call) => {
    await db.withTenantContext(7, call);
    expect(mockQueries.length).toBeGreaterThan(0);
    expect(placesOf()).toEqual(['primary']);
  });
});

describe('/users and /roles for an isolated organization', () => {
  const request = require('supertest');
  const app = require('../src/app');

  test('GET /roles reads the primary database', async () => {
    const res = await request(app).get('/api/v1/roles');
    expect(res.status).toBe(200);
    expect(mockQueries.some((q) => /FROM roles/.test(q.sql))).toBe(true);
    expect(placesOf()).toEqual(['primary']);
  });

  test('GET /users/:id reads the user the list shows', async () => {
    await request(app).get('/api/v1/users/41');
    const lookups = mockQueries.filter((q) => /FROM `?users`?/.test(q.sql));
    expect(lookups.length).toBeGreaterThan(0);
    expect([...new Set(lookups.map((q) => q.where))]).toEqual(['primary']);
  });
});

describe('GraphQL permission lookup', () => {
  test('runs in the primary context for an isolated organization', async () => {
    const { assertGraphqlPermission } = require('../src/graphql/authz');
    const seen = [];
    const spy = jest.spyOn(User, 'getPermissions').mockImplementation(async () => {
      seen.push(mockScope.getStore());
      return ['clients.view'];
    });
    const ctx = { user: { id: 5, role: 'billing', organizationId: 7 } };
    await db.withTenantContext(7, () => assertGraphqlPermission(ctx, ['clients.view']));
    await db.withTenantContext(7, () => assertGraphqlPermission(ctx, ['clients.view']));
    expect(seen).toEqual(['primary']); // once per request, memoized on ctx
    spy.mockRestore();
  });
});
