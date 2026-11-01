// =============================================================================
// FE2-04 — deleting a CPE unit cannot skip stock, ledger or pickup
// =============================================================================
// DELETE /cpe-management/devices/:id soft-deleted any unit. An installed rented
// unit then dropped out of the cancellation pickup and its serial could be
// registered again; a tracked in-stock unit left inventory_stock and the
// ledger unchanged. /lifecycle/transition already refused the same moves.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin', organizationId: 1 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const db = require('../src/config/database');
const app = require('../src/app');

let unit;
beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql) => {
    if (/^\s*SELECT/i.test(sql)) return [[unit]];
    return [{ affectedRows: 1 }];
  });
});

const deletes = () => db.query.mock.calls.filter(([sql]) => /UPDATE `?cpe_devices`? SET deleted_at/.test(sql));

test.each([
  ['an assigned rented unit', { lifecycle_state: 'assigned', ownership: 'rented', inventory_item_id: 4 }, 'CPE_UNIT_INSTALLED'],
  ['an active unit', { lifecycle_state: 'active', ownership: 'sold', inventory_item_id: null }, 'CPE_UNIT_INSTALLED'],
  ['a tracked unit in stock', { lifecycle_state: 'in_stock', inventory_item_id: 4 }, 'CPE_UNIT_TRACKED'],
  ['a tracked returned unit', { lifecycle_state: 'returned', inventory_item_id: 4 }, 'CPE_UNIT_TRACKED'],
])('%s is refused', async (_label, state, code) => {
  unit = { id: 7, organization_id: 1, ...state };
  const res = await request(app).delete('/api/v1/cpe-management/devices/7');
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe(code);
  expect(deletes()).toHaveLength(0);
});

test('an untracked, uninstalled unit (e.g. auto-registered by TR-069) can be deleted', async () => {
  unit = { id: 7, organization_id: 1, lifecycle_state: 'in_stock', inventory_item_id: null };
  const res = await request(app).delete('/api/v1/cpe-management/devices/7');
  expect(res.status).toBe(204);
  expect(deletes()).toHaveLength(1);
});
