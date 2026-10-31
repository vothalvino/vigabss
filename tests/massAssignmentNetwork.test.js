// =============================================================================
// DB-15 — network write routes take only their declared fields, and never
// write installation-shared rows
// =============================================================================
// buildInsert/buildUpdate wrote every request-body key except a few the route
// stripped, so e.g. PUT /olt-management/ports/:id could set xgspon_mode,
// maintenance_mode or oper_status (which have their own guarded endpoints),
// and foreign ids reached the row. The fiber/OLT write lookups also accepted
// organization_id NULL (shared) rows and then updated by id alone.
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
  .set('Authorization', `Bearer ${token}`).send(body);

function fixture(rowOrg) {
  db.query.mockImplementation(async (sql) => {
    if (/^SELECT .* FROM \w+ WHERE id = \? AND \(organization_id = \? OR organization_id IS NULL\)/.test(sql)) {
      return [rowOrg === undefined ? [] : [{ id: 5, organization_id: rowOrg, status: 'pending' }]];
    }
    if (/^\s*(UPDATE|INSERT)/.test(sql)) return [{ affectedRows: 1, insertId: 5 }];
    return [[{ id: 5 }]];
  });
}
const writes = () => db.query.mock.calls.filter(([sql]) => /^\s*(UPDATE|INSERT)/.test(sql));

beforeEach(() => {
  db.query.mockReset();
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

test('an OLT port edit writes only the schema fields', async () => {
  fixture(1);
  const res = await call('put', '/olt-management/ports/5', {
    port_name: 'PON 1', xgspon_mode: 'xgspon_10g', xgspon_mode_validated: 1,
    maintenance_mode: 1, oper_status: 'down', olt_device_id: 99,
  });
  expect(res.status).toBe(200);
  const [sql, params] = writes()[0];
  expect(sql).toMatch(/^UPDATE olt_ports SET `port_name` = \?, updated_at = NOW\(\) WHERE id = \? AND organization_id <=> \?$/);
  expect(params).toEqual(['PON 1', '5', 1]);
});

test('a fiber route create cannot set columns its schema does not declare', async () => {
  fixture(1);
  await call('post', '/fiber-plant/fiber-routes', { name: 'Backbone', deleted_at: null, integrity_hash: 'x', some_column: 1 });
  const insert = writes().find(([sql]) => /INSERT INTO fiber_routes/.test(sql));
  expect(insert[0]).not.toMatch(/integrity_hash|some_column/);
});

test.each([
  ['put', '/olt-management/ports/5', { port_name: 'x' }],
  ['delete', '/olt-management/ports/5', undefined],
  ['put', '/fiber-plant/fiber-routes/5', { name: 'x' }],
  ['delete', '/fiber-plant/odf/frames/5', undefined],
  ['post', '/olt-management/onu-migrations/5/cancel', {}],
])('%s %s on an installation-shared row is refused', async (method, path, body) => {
  fixture(null);
  const res = await call(method, path, body);
  expect(res.status).toBe(403);
  expect(writes()).toHaveLength(0);
});

test("another tenant's row is not found", async () => {
  fixture(undefined);
  const res = await call('put', '/olt-management/ports/5', { port_name: 'x' });
  expect(res.status).toBe(404);
  expect(writes()).toHaveLength(0);
});
