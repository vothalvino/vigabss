// =============================================================================
// FE2-11 — data-pack status maps to data_packs.is_active
// =============================================================================
// The admin page and validator sent status, but the service only knew
// is_active, so choosing "inactive" changed nothing; the admin list showed
// active packs only, so a pack switched off could never be switched back on.
// =============================================================================
'use strict';

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/rolloverService', () => ({}));

const db = require('../src/config/database');
const svc = require('../src/services/dataPackService');

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql) => (/^\s*SELECT/.test(sql)
    ? [[{ id: 3, is_active: 0, name: 'Extra 10 GB' }]]
    : [{ insertId: 3, affectedRows: 1 }]));
});

test("status 'inactive' on update writes is_active = 0", async () => {
  const pack = await svc.updatePack(3, 1, { status: 'inactive' });
  const [sql, params] = db.query.mock.calls.find(([q]) => /UPDATE data_packs/.test(q));
  expect(sql).toMatch(/is_active = \?/);
  expect(sql).not.toMatch(/status/);
  expect(params[0]).toBe(0);
  expect(pack.status).toBe('inactive');
});

test("status 'inactive' on create stores an inactive pack", async () => {
  await svc.createPack(1, { name: 'Extra', data_gb: 10, price: 99, status: 'inactive' });
  const [, params] = db.query.mock.calls.find(([q]) => /INSERT INTO data_packs/.test(q));
  expect(params[params.length - 1]).toBe(0);
});

test('the admin catalog includes inactive packs; the default does not', async () => {
  await svc.listPacks(1, { includeInactive: true });
  expect(db.query.mock.calls[0][0]).not.toMatch(/is_active = 1/);
  await svc.listPacks(1);
  expect(db.query.mock.calls[1][0]).toMatch(/is_active = 1/);
});
