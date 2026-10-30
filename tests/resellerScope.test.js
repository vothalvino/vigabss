// =============================================================================
// VigaBSS 5.0 — Reseller user binding and scope (audit TNB-13)
// =============================================================================
// Reseller routes only checked that the URL reseller belonged to the caller's
// organization, so any reseller_admin read and managed every reseller's
// customers, invoices, inventory and billing entity (bank account/CLABE).
// Migration 475 binds a user to one reseller; a bound user is confined to that
// reseller's subtree, an unbound reseller_admin is refused, and org-level
// staff keep cross-reseller access inside their organization.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn() }));
jest.mock('../src/services/quotaService', () => ({
  checkQuota: jest.fn(),
  getQuota: jest.fn(),
  getUsage: jest.fn(),
  getQuotaWithUsage: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const quotaService = require('../src/services/quotaService');
const { ValidationError } = require('../src/utils/errors');
const app = require('../src/app');

const ORG = 1;
// R1 (master) has sub-reseller R3; R2 is an unrelated master in the same org.
const RESELLERS = {
  1: { id: 1, organization_id: ORG, parent_id: null, level: 1, name: 'R1', status: 'active' },
  2: { id: 2, organization_id: ORG, parent_id: null, level: 1, name: 'R2', status: 'active' },
  3: { id: 3, organization_id: ORG, parent_id: 1, level: 2, name: 'R3', status: 'active' },
};
const CHILDREN = { 1: [{ id: 3 }] };
const CLIENTS = {
  31: { id: 31, status: 'active', reseller_id: 3 }, // R1's sub-reseller client
  21: { id: 21, status: 'active', reseller_id: 2 }, // R2's client
};

let binding; // reseller_user_bindings row for the caller, or undefined
let groupName; // the caller's live group name, or undefined

function installDb() {
  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql);
    if (/FROM reseller_user_bindings b/.test(s)) return [binding ? [binding] : []];
    if (/JOIN roles g ON g\.id = u\.group_id/.test(s)) return [groupName ? [{ group_name: groupName }] : []];
    if (/FROM resellers\s+WHERE organization_id = \? AND parent_id IN/.test(s)) {
      return [params.slice(1).flatMap((id) => CHILDREN[id] || [])];
    }
    if (/^SELECT \* FROM resellers WHERE id = \? AND organization_id = \?/.test(s)) {
      const r = RESELLERS[Number(params[0])];
      return [r && Number(params[1]) === ORG ? [r] : []];
    }
    if (/FROM resellers r/.test(s) && /LEFT JOIN/.test(s)) return [[RESELLERS[1]]];
    if (/COUNT\(\*\) AS total FROM resellers r/.test(s)) return [[{ total: 1 }]];
    if (/FROM reseller_billing_entities/.test(s)) {
      return [[{ reseller_id: Number(params[0]), bank_account: '000', bank_clabe: '012345678901234567' }]];
    }
    if (/SELECT id, status, reseller_id FROM clients WHERE id = \?/.test(s)) {
      const c = CLIENTS[Number(params[0])];
      return [c ? [c] : []];
    }
    if (/FROM clients WHERE organization_id = \? AND reseller_id IN/.test(s) && /COUNT/.test(s)) return [[{ total: 0 }]];
    if (/INSERT INTO clients/.test(s)) return [{ insertId: 77 }];
    if (/UPDATE clients SET status/.test(s)) return [{ affectedRows: 1 }];
    if (/INSERT INTO reseller_user_bindings/.test(s)) return [{ affectedRows: 1 }];
    if (/FROM reseller_user_bindings WHERE organization_id = \? AND user_id = \?/.test(s)) {
      return [[{ id: 5, organization_id: ORG, user_id: Number(params[1]), reseller_id: 1 }]];
    }
    if (/SELECT COUNT\(\*\) AS cnt/.test(s)) return [[{ cnt: 0 }]];
    if (/COALESCE\(SUM/.test(s)) return [[{ rev: 0, total: 0 }]];
    return [[]];
  });
}

function tokenFor(role) {
  return jwt.sign({ sub: 7, email: `${role}@example.com`, role, orgId: ORG }, config.jwt.secret, { expiresIn: '1h' });
}

/** A reseller_admin-group user (legacy users.role 'billing'; no bypass). */
function asResellerAdmin() {
  groupName = 'reseller_admin';
  User.findById.mockResolvedValue({ id: 7, email: 'r@example.com', status: 'active', role: 'billing', organization_id: ORG });
  User.getPermissions.mockResolvedValue([
    'resellers.view', 'reseller_plan_prices.view', 'reseller_commissions.view',
    'reseller_ip_pool_allocations.view', 'reseller_bandwidth_quotas.view',
    'reseller_olt_port_assignments.view', 'reseller_billing_entities.view',
    'reseller_portal.dashboard', 'reseller_portal.manage_customers',
    'reseller_portal.invoices', 'reseller_portal.inventory',
  ]);
  return tokenFor('billing');
}

/** Org-level staff in an admin-kind group with every reseller slug. */
function asOrgAdmin() {
  groupName = 'admin';
  User.findById.mockResolvedValue({ id: 7, email: 'a@example.com', status: 'active', role: 'support', organization_id: ORG });
  User.getPermissions.mockResolvedValue([
    'resellers.view', 'resellers.create', 'resellers.update', 'users.update',
    'reseller_billing_entities.view', 'reseller_portal.dashboard',
    'reseller_portal.manage_customers', 'reseller_portal.invoices', 'reseller_portal.inventory',
  ]);
  return tokenFor('support');
}

const get = (path, token) => request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
const post = (path, token, body = {}) => request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);
const put = (path, token, body = {}) => request(app).put(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

beforeEach(() => {
  jest.resetAllMocks();
  binding = undefined;
  groupName = undefined;
  quotaService.checkQuota.mockResolvedValue();
  installDb();
});

describe('TNB-13 — a user bound to R1 is confined to R1 and its sub-resellers', () => {
  beforeEach(() => { binding = { reseller_id: 1, live_reseller_id: 1 }; });

  test.each([
    '/reseller-portal/2/dashboard',
    '/reseller-portal/2/clients',
    '/reseller-portal/2/invoices',
    '/reseller-portal/2/inventory',
    '/resellers/2',
    '/resellers/2/billing-entity',
    '/resellers/2/plan-prices',
    '/resellers/2/commissions',
    '/resellers/2/ip-pools',
    '/resellers/2/bandwidth-quota',
    '/resellers/2/olt-ports',
  ])('GET %s for another reseller is 404', async (path) => {
    const res = await get(path, asResellerAdmin());
    expect(res.status).toBe(404);
  });

  test('POST a customer under another reseller is 404 and inserts nothing', async () => {
    const res = await post('/reseller-portal/2/clients', asResellerAdmin(), { name: 'Stolen' });
    expect(res.status).toBe(404);
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO clients/.test(sql))).toBe(false);
  });

  test("suspending another reseller's customer through the caller's own id is 404", async () => {
    const res = await post('/reseller-portal/1/clients/21/suspend', asResellerAdmin());
    expect(res.status).toBe(404);
    expect(db.query.mock.calls.some(([sql]) => /UPDATE clients/.test(sql))).toBe(false);
  });

  test('own reseller and sub-reseller remain reachable', async () => {
    const token = asResellerAdmin();
    expect((await get('/resellers/1/billing-entity', token)).status).toBe(200);
    expect((await get('/reseller-portal/3/dashboard', token)).status).toBe(200);
    // A master may manage its sub-reseller's customer.
    const res = await post('/reseller-portal/1/clients/31/suspend', token);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('suspended');
  });

  test('GET /resellers is filtered to the subtree in SQL', async () => {
    const res = await get('/resellers', asResellerAdmin());
    expect(res.status).toBe(200);
    const call = db.query.mock.calls.find(([sql]) => /FROM resellers r/.test(sql) && /LEFT JOIN/.test(sql));
    expect(call[0]).toMatch(/r\.id IN \(\?, \?\)/);
    expect(call[1]).toEqual([ORG, 1, 3]);
  });

  test('a bound user cannot manage bindings even with the permissions', async () => {
    binding = { reseller_id: 1, live_reseller_id: 1 };
    const token = asOrgAdmin(); // bound admin-group user: binding wins
    const res = await put('/resellers/1/users/9', token);
    expect(res.status).toBe(403);
  });
});

describe('TNB-13 — fail closed', () => {
  test.each([
    '/reseller-portal/1/dashboard',
    '/reseller-portal/2/clients',
    '/resellers',
    '/resellers/2/billing-entity',
  ])('an unbound reseller_admin gets 403 on %s', async (path) => {
    const res = await get(path, asResellerAdmin());
    expect(res.status).toBe(403);
  });

  test('a binding whose reseller was deleted gets 403', async () => {
    binding = { reseller_id: 1, live_reseller_id: null };
    const res = await get('/reseller-portal/1/dashboard', asResellerAdmin());
    expect(res.status).toBe(403);
  });
});

describe('TNB-13 — org-level staff keep cross-reseller access in their org', () => {
  test('an unbound admin reads any reseller of the org', async () => {
    const token = asOrgAdmin();
    expect((await get('/reseller-portal/2/dashboard', token)).status).toBe(200);
    expect((await get('/resellers/2/billing-entity', token)).status).toBe(200);
    const list = await get('/resellers', token);
    const call = db.query.mock.calls.find(([sql]) => /FROM resellers r/.test(sql) && /LEFT JOIN/.test(sql));
    expect(list.status).toBe(200);
    expect(call[0]).not.toMatch(/r\.id IN/);
  });

  test('another organization\'s reseller id is still 404', async () => {
    const res = await get('/resellers/999/billing-entity', asOrgAdmin());
    expect(res.status).toBe(404);
  });
});

describe('TNB-13 — portal customer creation uses the shared client rules', () => {
  test('the tenant client quota is enforced', async () => {
    quotaService.checkQuota.mockRejectedValue(new ValidationError('Tenant quota exceeded'));
    const res = await post('/reseller-portal/2/clients', asOrgAdmin(), { name: 'Over quota' });
    expect(res.status).toBe(422);
    expect(quotaService.checkQuota).toHaveBeenCalledWith(ORG, 'clients');
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO clients/.test(sql))).toBe(false);
  });

  test('the client create schema is validated', async () => {
    const res = await post('/reseller-portal/2/clients', asOrgAdmin(), { name: 'X', email: 'not-an-email' });
    expect(res.status).toBe(422);
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO clients/.test(sql))).toBe(false);
  });

  test('a valid customer is created under the URL reseller', async () => {
    const res = await post('/reseller-portal/2/clients', asOrgAdmin(), { name: 'Ok', email: 'ok@example.com' });
    expect(res.status).toBe(201);
    const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO clients/.test(sql));
    expect(insert[1].slice(0, 3)).toEqual([ORG, '2', 'Ok']);
  });
});

describe('TNB-13 — binding management', () => {
  test('an org admin binds a user of the organization', async () => {
    User.count.mockResolvedValue(1);
    const res = await put('/resellers/1/users/9', asOrgAdmin());
    expect(res.status).toBe(200);
    const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO reseller_user_bindings/.test(sql));
    expect(insert[1]).toEqual([ORG, 9, '1', 7]);
    expect(User.count).toHaveBeenCalledWith({ where: { id: 9 }, orgId: ORG });
  });

  test('a user outside the organization is 404', async () => {
    User.count.mockResolvedValue(0);
    const res = await put('/resellers/1/users/9', asOrgAdmin());
    expect(res.status).toBe(404);
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO reseller_user_bindings/.test(sql))).toBe(false);
  });

  test('binding your own account is refused', async () => {
    User.count.mockResolvedValue(1);
    const res = await put('/resellers/1/users/7', asOrgAdmin());
    expect(res.status).toBe(422);
  });

  test('a reseller_admin without users.update cannot bind anyone', async () => {
    binding = { reseller_id: 1, live_reseller_id: 1 };
    const res = await put('/resellers/1/users/9', asResellerAdmin());
    expect(res.status).toBe(403);
  });
});
