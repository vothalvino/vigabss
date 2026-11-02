// =============================================================================
// TNB-31 — numbering, network-security and report-definition mutations
// validate their input and report a missing row
// =============================================================================
// The numbering routes had no validation, so an omitted phone_number reached
// mysql2 as undefined (a 500), and PUT/DELETE answered {success:true} for a row
// that did not exist. Firewall-rule and DNS-blocklist updates cleared src/dst
// and expires_at whenever the field was omitted. The report-definition PUT
// bound undefined name/category and skipped the category check that POST has.
// =============================================================================
'use strict';

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin', organizationId: 1 }; req.userId = 1; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/database');

let affectedRows;
beforeEach(() => {
  jest.clearAllMocks();
  affectedRows = 1;
  db.query.mockImplementation(async (sql) => {
    if (/^\s*SELECT \* FROM report_definitions/.test(sql)) return [[{ id: 2, name: 'mine', category: 'custom' }]];
    if (/^\s*SELECT/.test(sql)) return [[{ id: 1 }]];
    if (/^\s*INSERT/.test(sql)) return [{ insertId: 1 }];
    return [{ affectedRows }];
  });
});

const call = (re) => db.query.mock.calls.find(([sql]) => re.test(sql));

describe('numbering management', () => {
  test('a phone number without phone_number is a 422, not a 500', async () => {
    const res = await request(app).post('/api/v1/numbering-management/phone-numbers').send({ status: 'available' });
    expect(res.status).toBe(422);
    expect(call(/INSERT INTO phone_number_inventory/)).toBeUndefined();
  });

  test('an unknown status is refused', async () => {
    const res = await request(app).put('/api/v1/numbering-management/phone-numbers/5').send({ status: 'stolen' });
    expect(res.status).toBe(422);
  });

  test('a partial update changes only the fields sent', async () => {
    const res = await request(app).put('/api/v1/numbering-management/phone-numbers/5').send({ notes: 'moved' });
    expect(res.status).toBe(200);
    const [sql, params] = call(/UPDATE phone_number_inventory/);
    expect(sql).not.toMatch(/phone_number = \?|status = \?/);
    expect(params).toEqual(['moved', '5', 1]);
  });

  test.each([
    ['put', '/api/v1/numbering-management/phone-numbers/9', { notes: 'x' }],
    ['delete', '/api/v1/numbering-management/phone-numbers/9', undefined],
    ['put', '/api/v1/numbering-management/portability/9', { status: 'approved' }],
    ['put', '/api/v1/numbering-management/portability/9/complete', undefined],
    ['put', '/api/v1/numbering-management/numbering-blocks/9', { notes: 'x' }],
  ])('%s %s on a missing row is a 404', async (method, url, body) => {
    affectedRows = 0;
    const res = await request(app)[method](url).send(body);
    expect(res.status).toBe(404);
  });

  test('a portability update with an unknown status is refused', async () => {
    const res = await request(app).put('/api/v1/numbering-management/portability/9').send({ status: 'done' });
    expect(res.status).toBe(422);
  });

  test('a numbering-block update without notes keeps them', async () => {
    await request(app).put('/api/v1/numbering-management/numbering-blocks/9').send({ status: 'exhausted' });
    const [sql] = call(/UPDATE numbering_blocks/);
    expect(sql).not.toMatch(/notes/);
  });
});

describe('network security', () => {
  test('a firewall-rule update without addresses keeps them', async () => {
    const res = await request(app).put('/api/v1/network-security/firewall-rules/3').send({ name: 'Edge' });
    expect(res.status).toBe(200);
    const [sql, params] = call(/UPDATE firewall_rules SET/);
    expect(sql).toMatch(/src_ip = IF\(\?, \?, src_ip\)/);
    // [isSet, value] pairs for src_ip, src_port, dst_ip, dst_port
    expect(params.slice(4, 12)).toEqual([0, null, 0, null, 0, null, 0, null]);
  });

  test('an explicit null still clears an address', async () => {
    await request(app).put('/api/v1/network-security/firewall-rules/3').send({ src_ip: null });
    const [, params] = call(/UPDATE firewall_rules SET/);
    expect(params.slice(4, 6)).toEqual([1, null]);
  });

  test('a DNS-blocklist update without expires_at keeps it', async () => {
    await request(app).put('/api/v1/network-security/dns-blocklists/3').send({ category: 'ads' });
    const [sql, params] = call(/UPDATE dns_blocklists SET/);
    expect(sql).toMatch(/expires_at = IF\(\?, \?, expires_at\)/);
    expect(params.slice(5, 7)).toEqual([0, null]);
  });
});

describe('report definitions', () => {
  test('PUT refuses an unknown category, as POST does', async () => {
    const res = await request(app).put('/api/v1/report-definitions/2').send({ category: 'secret' });
    expect(res.status).toBe(422);
    expect(call(/UPDATE report_definitions/)).toBeUndefined();
  });

  test('PUT without name or category binds null, never undefined', async () => {
    const res = await request(app).put('/api/v1/report-definitions/2').send({ description: 'New' });
    expect(res.status).toBe(200);
    const [, params] = call(/UPDATE report_definitions/);
    expect(params.slice(0, 2)).toEqual([null, null]);
  });
});
