// =============================================================================
// Reseller app, phase 3: a user is never both a reseller login and a carrier
// =============================================================================
// PUT /resellers/:id/users/:userId refuses to bind a carrier. The other
// direction goes through the Users page: PUT/PATCH /users/:id (the update
// hook) and PATCH /users/:id/group (archived users) refuse the system carrier
// group to a user bound to a reseller in any of its organizations.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(),
  getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
  withTenantContext: jest.fn((_orgId, fn) => fn()),
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const User = require('../src/models/User');
const { clearCarrierGroupCache } = require('../src/services/carrierAccount');

const CARRIER_GROUP = 50;
const SUPPORT_GROUP = 3;
const BOUND_USER = 60;
const FREE_USER = 61;
// user id -> organization ids in which it is bound to a reseller
const BINDINGS = { [BOUND_USER]: [2] };

function answer(sql, params = []) {
  const s = String(sql);
  if (/SELECT name, is_system FROM roles WHERE id = \?/.test(s)) {
    const id = Number(params[0]);
    if (id === CARRIER_GROUP) return [[{ name: 'carrier', is_system: 1 }]];
    if (id === SUPPORT_GROUP) return [[{ name: 'support', is_system: 1 }]];
    return [[]];
  }
  if (/FROM reseller_user_bindings b/.test(s)) {
    const [orgId, userId] = params.map(Number);
    return [(BINDINGS[userId] || []).includes(orgId) ? [{ reseller_id: 1, live_reseller_id: 1, reseller_name: 'Tienda' }] : []];
  }
  return [[]];
}

let options;
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
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  clearCarrierGroupCache();
  db.query.mockImplementation(async (sql, params) => answer(sql, params));
  db.withTenantContext.mockImplementation((_orgId, fn) => fn());
  // Home organization 1; also a member of organization 2.
  User.getOrganizations.mockResolvedValue([{ id: 1 }, { id: 2 }]);
  User.resolveGroupMirror.mockImplementation(async (data) => data);
  User.countOtherAdminKindUsers.mockResolvedValue(1);
});

const old = (id) => ({ id, organization_id: 1, role: 'support', status: 'active', group_id: SUPPORT_GROUP });
const req = (body) => ({ body, orgId: 1, user: { id: 7 } });

describe('the users update hook', () => {
  test('refuses the carrier group to a user bound to a reseller in another of its organizations', async () => {
    await expect(options.beforeUpdate(old(BOUND_USER), req({ group_id: CARRIER_GROUP })))
      .rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/cannot also be a carrier/) });
    // Looked the binding up in each organization, inside its tenant context.
    expect(db.withTenantContext).toHaveBeenCalledWith(2, expect.any(Function));
    expect(User.resolveGroupMirror).not.toHaveBeenCalled();
  });

  test('lets an unbound user become a carrier', async () => {
    await expect(options.beforeUpdate(old(FREE_USER), req({ group_id: CARRIER_GROUP }))).resolves.toBeUndefined();
    expect(User.resolveGroupMirror).toHaveBeenCalled();
  });

  test('lets a bound user change to another group, or keep editing without a group', async () => {
    await expect(options.beforeUpdate(old(BOUND_USER), req({ group_id: SUPPORT_GROUP }))).resolves.toBeUndefined();
    await expect(options.beforeUpdate(old(BOUND_USER), req({ first_name: 'Lupita' }))).resolves.toBeUndefined();
    expect(db.query.mock.calls.some(([sql]) => /reseller_user_bindings/.test(sql))).toBe(false);
  });
});
