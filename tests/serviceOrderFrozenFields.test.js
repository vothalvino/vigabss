// =============================================================================
// RTE-03 — a started order's type and links are frozen; new_install is gated
// =============================================================================
// PUT/PATCH (service_orders.update) accepted order_type and contract_id at any
// status, so an order could be relabelled or pointed at another pending
// contract and then cancelled, cancelling that contract.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));

let options;
let rbac;
let db;
beforeAll(() => {
  jest.isolateModules(() => {
    jest.doMock('../src/controllers/crudController', () => ({
      crudController: (_model, opts) => {
        options = opts;
        const noop = (_req, _res, next) => next();
        return { list: noop, get: noop, create: noop, update: noop, partialUpdate: noop, destroy: noop, restore: noop };
      },
    }));
    jest.doMock('../src/middleware/rbac', () => ({
      requirePermission: () => (_req, _res, next) => next(),
      userHasPermission: jest.fn(async () => false),
    }));
    require('../src/routes/serviceOrders');
    rbac = require('../src/middleware/rbac');
    db = require('../src/config/database');
  });
});

const update = (old, body) => options.beforeUpdate(old, { body, orgId: 1, user: { id: 2 } });

test.each([
  [{ order_type: 'new_install' }],
  [{ contract_id: 900 }],
  [{ client_id: 77 }],
  [{ lead_id: 5 }],
])('a started order refuses %j', async (body) => {
  const old = { id: 1, status: 'in_process', order_type: 'upgrade', contract_id: null, client_id: 3, lead_id: null };
  await expect(update(old, body)).rejects.toMatchObject({ statusCode: 422 });
});

test('a started order accepts an edit that re-sends the same values', async () => {
  const old = { id: 1, status: 'in_process', order_type: 'upgrade', contract_id: 9, client_id: 3, lead_id: null };
  // The re-sent contract_id still goes through the ownership check.
  db.query.mockResolvedValue([[{ id: 9, organization_id: 1 }]]);
  await expect(update(old, { order_type: 'upgrade', contract_id: 9, notes: 'x' })).resolves.toBeUndefined();
});

test('making a new order a new installation needs installations.start or contracts.update', async () => {
  const old = { id: 1, status: 'new', order_type: 'upgrade', contract_id: null, client_id: null, lead_id: null };
  await expect(update(old, { order_type: 'new_install' })).rejects.toMatchObject({ statusCode: 403 });
  rbac.userHasPermission.mockImplementation(async (_req, slug) => slug === 'installations.start');
  await expect(update(old, { order_type: 'new_install' })).resolves.toBeUndefined();
});
