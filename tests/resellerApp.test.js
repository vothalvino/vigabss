// =============================================================================
// Reseller app, phase 1 (migration 003)
// =============================================================================
// A user bound to a reseller signs customers up as leads through
// /api/v1/reseller-app and reaches nothing else of the staff API
// (middleware/resellerFence.js). Org-level staff manage the reseller's
// allowed plans and logins; a reseller-bound caller cannot raise its own
// commission or status.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  // The real module has it; with it the fence and /auth/me look bindings up.
  withTenantContext: jest.fn((_orgId, fn) => fn()),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn() }));
jest.mock('../src/services/leadFeasibilityService', () => ({ assess: jest.fn() }));

const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const auditLog = require('../src/services/auditLog');
const leadFeasibilityService = require('../src/services/leadFeasibilityService');
const app = require('../src/app');

const ORG = 1;
// R1 (master) has sub-reseller R3; R2 is an unrelated master in the same org.
const RESELLERS = {
  1: { id: 1, organization_id: ORG, parent_id: null, level: 1, name: 'R1', status: 'active', commission_rate: '10.00' },
  2: { id: 2, organization_id: ORG, parent_id: null, level: 1, name: 'R2', status: 'active', commission_rate: '5.00' },
  3: { id: 3, organization_id: ORG, parent_id: 1, level: 2, name: 'R3', status: 'active', commission_rate: '0.00' },
};
const CHILDREN = { 1: [{ id: 3 }] };
const CLIENTS = {
  31: { id: 31, name: 'Ana', phone: '5550001', email: 'ana@example.com', address: 'Calle 1', city: 'Toluca', status: 'active', reseller_id: 3 },
  21: { id: 21, name: 'Beto', phone: '5550002', email: null, address: null, city: null, status: 'active', reseller_id: 2 },
};
const PLANS = [
  { id: 10, name: 'Hogar 20', price: '299.00', download_speed_mbps: 20, upload_speed_mbps: 5 },
  { id: 11, name: 'Hogar 50', price: '449.00', download_speed_mbps: 50, upload_speed_mbps: 10 },
];

let binding; // reseller_user_bindings row for the caller, or undefined
let groupName; // the caller's live group name, or undefined
let allowedPlanIds; // reseller_allowed_plans of R1
let resellerStatus;

function installDb() {
  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql);
    if (/FROM reseller_user_bindings b/.test(s)) return [binding ? [binding] : []];
    if (/JOIN roles g ON g\.id = u\.group_id/.test(s)) return [groupName ? [{ group_name: groupName }] : []];
    if (/FROM resellers\s+WHERE organization_id = \? AND parent_id IN/.test(s)) {
      return [params.slice(1).flatMap((id) => CHILDREN[id] || [])];
    }
    if (/^SELECT \* FROM resellers WHERE id = \? AND organization_id = \?/.test(s)
        || /FROM resellers WHERE id = \? AND organization_id = \? AND deleted_at IS NULL/.test(s)) {
      const r = RESELLERS[Number(params[0])];
      return [r && Number(params[1]) === ORG ? [{ ...r, status: Number(params[0]) === 1 ? resellerStatus : r.status }] : []];
    }
    if (/UPDATE resellers SET/.test(s)) return [{ affectedRows: 1 }];
    if (/INSERT INTO resellers/.test(s)) return [{ insertId: 4 }];
    // reseller app: clients
    if (/FROM clients c\s+WHERE c\.id = \?/.test(s)) {
      const c = CLIENTS[Number(params[0])];
      const ids = params.slice(2).map(Number);
      return [c && Number(params[1]) === ORG && ids.includes(c.reseller_id) ? [c] : []];
    }
    if (/FROM clients c\s+WHERE c\.deleted_at IS NULL AND c\.organization_id = \?/.test(s) && /balance_due/.test(s)) {
      return [[{ ...CLIENTS[31], balance_due: '120.50', overdue: 1 }]];
    }
    if (/COUNT\(\*\) AS total FROM clients c/.test(s)) return [[{ total: 1 }]];
    if (/FROM contracts ct/.test(s)) return [[{ id: 70, status: 'active', plan_name: 'Hogar 20', monthly_price: '299.00' }]];
    if (/AS balance\s+FROM invoices i/.test(s)) {
      return [[{ id: 80, invoice_number: 'F-1', status: 'overdue', total: '299.00', balance: '120.50', due_date: '2026-10-01', issue_date: '2026-09-25' }]];
    }
    if (/AS balance_due\s+FROM invoices i/.test(s)) return [[{ balance_due: '120.50' }]];
    // reseller app: counts
    if (/AS active_clients/.test(s)) return [[{ active_clients: '4', suspended_clients: '1' }]];
    if (/AS open_leads/.test(s)) return [[{ open_leads: 2 }]];
    if (/AS overdue_clients/.test(s)) return [[{ overdue_clients: 1 }]];
    // allowed plans
    if (/SELECT COUNT\(\*\) AS total FROM reseller_allowed_plans/.test(s)) return [[{ total: allowedPlanIds.length }]];
    if (/FROM reseller_allowed_plans rap\s+JOIN plans p/.test(s) && /download_speed_mbps/.test(s)) {
      return [PLANS.filter((p) => allowedPlanIds.includes(p.id))];
    }
    if (/FROM reseller_allowed_plans rap/.test(s)) {
      return [PLANS.filter((p) => allowedPlanIds.includes(p.id)).map((p) => ({ plan_id: p.id, name: p.name, price: p.price }))];
    }
    if (/FROM plans p\s+WHERE p\.organization_id = \?/.test(s)) return [PLANS];
    if (/SELECT id FROM plans WHERE organization_id = \?/.test(s)) {
      return [params.slice(1).filter((id) => PLANS.some((p) => p.id === id)).map((id) => ({ id }))];
    }
    // leads
    if (/INSERT INTO leads/.test(s)) return [{ insertId: 900 }];
    if (/FROM leads WHERE id = \? AND organization_id = \?/.test(s)) {
      return [[{ id: 900, name: 'Carla', phone: '5550003', email: null, address: null, city: null, latitude: '19.2800000', longitude: '-99.6500000', status: 'new', desired_plan_id: 10, reseller_id: 1, created_at: '2026-11-06T10:00:00.000Z', converted_client_id: null }]];
    }
    if (/FROM leads\s+WHERE id = \? AND organization_id = \?/.test(s)) {
      // feasibility guard: lead 900 belongs to R1, lead 901 to R2
      const ids = params.slice(2).map(Number);
      const owner = { 900: 1, 901: 2 }[Number(params[0])];
      return [owner && ids.includes(owner) ? [{ id: Number(params[0]) }] : []];
    }
    if (/FROM leads l/.test(s) && /desired_plan_name/.test(s)) {
      return [[{ id: 900, name: 'Carla', phone: '5550003', status: 'new', desired_plan_id: 10, desired_plan_name: 'Hogar 20', created_at: '2026-11-06T10:00:00.000Z', converted_client_id: null }]];
    }
    if (/COUNT\(\*\) AS total FROM leads l/.test(s)) return [[{ total: 1 }]];
    // users / bindings
    if (/FROM roles WHERE name = 'reseller_admin'/.test(s)) return [[{ id: 8 }]];
    if (/INSERT INTO reseller_user_bindings/.test(s)) return [{ affectedRows: 1, insertId: 55 }];
    if (/SELECT id FROM reseller_user_bindings WHERE organization_id = \? AND user_id = \?/.test(s)) return [[{ id: 55 }]];
    return [[]];
  });
}

function tokenFor(role) {
  return jwt.sign({ sub: 7, email: `${role}@example.com`, role, orgId: ORG }, config.jwt.secret, { expiresIn: '1h' });
}

/** A reseller_admin-group user bound to R1. */
function asBoundReseller(permissions = ['reseller_app.use', 'reseller_app.signup', 'reseller_portal.dashboard']) {
  groupName = 'reseller_admin';
  binding = { reseller_id: 1, live_reseller_id: 1, reseller_name: 'R1' };
  User.findById.mockResolvedValue({ id: 7, email: 'r@example.com', status: 'active', role: 'billing', organization_id: ORG });
  User.getPermissions.mockResolvedValue(permissions);
  return tokenFor('billing');
}

/** Org-level staff in an admin-kind group with every slug it needs. */
function asOrgAdmin(extra = []) {
  groupName = 'admin';
  binding = undefined;
  User.findById.mockResolvedValue({ id: 7, email: 'a@example.com', status: 'active', role: 'support', organization_id: ORG });
  User.getPermissions.mockResolvedValue([
    'reseller_app.use', 'reseller_app.signup', 'resellers.view', 'resellers.create', 'resellers.update',
    'users.create', 'users.update', 'clients.view', ...extra,
  ]);
  return tokenFor('support');
}

const auth = (r, token) => r.set('Authorization', `Bearer ${token}`);
const get = (path, token) => auth(request(app).get(`/api/v1${path}`), token);
const post = (path, token, body = {}) => auth(request(app).post(`/api/v1${path}`), token).send(body);
const put = (path, token, body = {}) => auth(request(app).put(`/api/v1${path}`), token).send(body);
const sqlCalls = (re) => db.query.mock.calls.filter(([sql]) => re.test(String(sql)));

let conn;
beforeEach(() => {
  jest.resetAllMocks();
  db.withTenantContext.mockImplementation((_orgId, fn) => fn());
  binding = undefined;
  groupName = undefined;
  allowedPlanIds = [];
  resellerStatus = 'active';
  conn = {
    beginTransaction: jest.fn().mockResolvedValue(),
    query: jest.fn().mockResolvedValue([{ affectedRows: 1 }]),
    commit: jest.fn().mockResolvedValue(),
    rollback: jest.fn().mockResolvedValue(),
    release: jest.fn(),
  };
  db.getConnection.mockResolvedValue(conn);
  installDb();
});

describe('only reseller accounts use the reseller app', () => {
  test.each(['/reseller-app/me', '/reseller-app/clients', '/reseller-app/plans', '/reseller-app/leads'])(
    'org-level staff get 403 on %s',
    async (path) => {
      const res = await get(path, asOrgAdmin());
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Only reseller accounts can use the reseller app');
    },
  );

  test('org-level staff cannot sign up a lead through it', async () => {
    const res = await post('/reseller-app/leads', asOrgAdmin(), { name: 'X', phone: '1' });
    expect(res.status).toBe(403);
    expect(sqlCalls(/INSERT INTO leads/)).toHaveLength(0);
  });

  test('an unbound reseller_admin is refused', async () => {
    const token = asBoundReseller();
    binding = undefined;
    const res = await get('/reseller-app/me', token);
    expect(res.status).toBe(403);
  });

  test('GET /me returns the bound reseller and its counts', async () => {
    const res = await get('/reseller-app/me', asBoundReseller());
    expect(res.status).toBe(200);
    expect(res.body.data.reseller).toEqual({ id: 1, name: 'R1', level: 1, status: 'active', commission_rate: 10, parent_id: null });
    expect(res.body.data.counts).toEqual({ active_clients: 4, suspended_clients: 1, open_leads: 2, overdue_clients: 1 });
    expect(typeof res.body.data.currency).toBe('string');
    // Every count binds the organization and the subtree (R1 and R3).
    for (const re of [/AS active_clients/, /AS open_leads/, /AS overdue_clients/]) {
      const [[, params]] = sqlCalls(re);
      expect(params.slice(0, 3)).toEqual([ORG, 1, 3]);
    }
  });
});

describe('clients of the subtree only', () => {
  test('the list binds the organization and the subtree in SQL', async () => {
    const res = await get('/reseller-app/clients?search=an&status=active', asBoundReseller());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: 31, name: 'Ana', phone: '5550001', email: 'ana@example.com', status: 'active', reseller_id: 3, balance_due: 120.5, overdue: true }]);
    expect(res.body.meta).toEqual({ total: 1, page: 1, limit: 25 });
    const [[sql, params]] = sqlCalls(/FROM clients c\s+WHERE c\.deleted_at IS NULL AND c\.organization_id = \?/).filter(([q]) => /balance_due/.test(q));
    expect(sql).toMatch(/c\.reseller_id IN \(\?, \?\)/);
    expect(params.slice(7)).toEqual([ORG, 1, 3, 'active', '%an%', '%an%', '%an%']);
  });

  test('an unknown status is 422', async () => {
    const res = await get('/reseller-app/clients?status=deleted', asBoundReseller());
    expect(res.status).toBe(422);
  });

  test('a client of the sub-reseller is visible with its contracts and invoices', async () => {
    const res = await get('/reseller-app/clients/31', asBoundReseller());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: 31, name: 'Ana', status: 'active', reseller_id: 3, balance_due: 120.5,
      contracts: [{ id: 70, status: 'active', plan_name: 'Hogar 20', monthly_price: 299 }],
      invoices: [{ id: 80, invoice_number: 'F-1', status: 'overdue', total: 299, balance: 120.5 }],
    });
    expect(res.body.data).not.toHaveProperty('notes');
  });

  test("another reseller's client is 404", async () => {
    const res = await get('/reseller-app/clients/21', asBoundReseller());
    expect(res.status).toBe(404);
    expect(sqlCalls(/FROM contracts ct/)).toHaveLength(0);
  });
});

describe('plans and lead sign-up', () => {
  test('with no allowed plans the reseller offers every active plan', async () => {
    const res = await get('/reseller-app/plans', asBoundReseller());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: 10, name: 'Hogar 20', price: 299, download_speed: 20, upload_speed: 5 },
      { id: 11, name: 'Hogar 50', price: 449, download_speed: 50, upload_speed: 10 },
    ]);
  });

  test('allowed plans narrow the offer', async () => {
    allowedPlanIds = [11];
    const res = await get('/reseller-app/plans', asBoundReseller());
    expect(res.body.data.map((p) => p.id)).toEqual([11]);
  });

  test('a sub-reseller offers the plans of its top-level reseller', async () => {
    allowedPlanIds = [11];
    const token = asBoundReseller();
    binding = { reseller_id: 3, live_reseller_id: 3, reseller_name: 'R3' };
    const res = await get('/reseller-app/plans', token);
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.id)).toEqual([11]);
    const lookups = sqlCalls(/reseller_allowed_plans/);
    expect(lookups.length).toBeGreaterThan(0);
    for (const [, params] of lookups) expect(params).toEqual([ORG, 1]);
  });

  test('a lead is created for the bound reseller', async () => {
    const res = await post('/reseller-app/leads', asBoundReseller(), {
      name: 'Carla', phone: '5550003', desired_plan_id: 10, latitude: 19.28, longitude: -99.65,
      rfc: 'xaxx010101000', reseller_id: 2, organization_id: 99, status: 'won',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: 900, reseller_id: 1, desired_plan_id: 10, desired_plan_name: 'Hogar 20', status: 'new' });
    const [[sql, params]] = sqlCalls(/INSERT INTO leads/);
    expect(sql).toMatch(/'referral', 'new'\)/);
    // organization and reseller come from the session, not the body
    expect(params.slice(0, 4)).toEqual([ORG, 1, 'Carla', '5550003']);
    expect(params).toContain('XAXX010101000');
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, tableName: 'leads', recordId: 900 }));
  });

  test('a plan the reseller does not offer is 422', async () => {
    allowedPlanIds = [11];
    const res = await post('/reseller-app/leads', asBoundReseller(), { name: 'Carla', phone: '5550003', desired_plan_id: 10 });
    expect(res.status).toBe(422);
    expect(sqlCalls(/INSERT INTO leads/)).toHaveLength(0);
  });

  test('name and phone are required, and fiscal fields keep the lead form rules', async () => {
    const token = asBoundReseller();
    expect((await post('/reseller-app/leads', token, { name: 'Carla' })).status).toBe(422);
    expect((await post('/reseller-app/leads', token, { name: 'Carla', phone: '1', codigo_postal_fiscal: '123456' })).status).toBe(422);
    expect((await post('/reseller-app/leads', token, { name: 'Carla', phone: '1', rfc: 'X'.repeat(14) })).status).toBe(422);
    expect(sqlCalls(/INSERT INTO leads/)).toHaveLength(0);
  });

  test('without reseller_app.signup the sign-up is 403', async () => {
    const res = await post('/reseller-app/leads', asBoundReseller(['reseller_app.use']), { name: 'Carla', phone: '1' });
    expect(res.status).toBe(403);
  });

  test('a suspended reseller cannot sign up customers', async () => {
    resellerStatus = 'suspended';
    const res = await post('/reseller-app/leads', asBoundReseller(), { name: 'Carla', phone: '1' });
    expect(res.status).toBe(403);
    expect(sqlCalls(/INSERT INTO leads/)).toHaveLength(0);
  });

  test('the lead list is confined to the subtree', async () => {
    const res = await get('/reseller-app/leads', asBoundReseller());
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toEqual({ id: 900, name: 'Carla', phone: '5550003', status: 'new', desired_plan_id: 10, desired_plan_name: 'Hogar 20', created_at: '2026-11-06T10:00:00.000Z', converted_client_id: null });
    const [[, params]] = sqlCalls(/FROM leads l/).filter(([q]) => /desired_plan_name/.test(q));
    expect(params).toEqual([ORG, 1, 3]);
  });

  test('feasibility is served for an own lead and 404 for another reseller\'s', async () => {
    leadFeasibilityService.assess.mockResolvedValue({ has_coordinates: true, coverage_zones: [], wireless: [], ftth: [] });
    const token = asBoundReseller();
    const own = await get('/reseller-app/leads/900/feasibility', token);
    expect(own.status).toBe(200);
    expect(own.body.data.has_coordinates).toBe(true);
    expect(leadFeasibilityService.assess).toHaveBeenCalledWith(900, ORG);
    const other = await get('/reseller-app/leads/901/feasibility', token);
    expect(other.status).toBe(404);
    expect(leadFeasibilityService.assess).toHaveBeenCalledTimes(1);
  });
});

describe('the fence', () => {
  test('allows the user\'s own passkeys but not the rest of security admin', () => {
    const { isResellerAllowedPath } = require('../src/middleware/resellerFence');
    expect(isResellerAllowedPath('/security-admin/webauthn')).toBe(true);
    expect(isResellerAllowedPath('/security-admin/webauthn/12')).toBe(true);
    expect(isResellerAllowedPath('/security-admin/admin-ip-allowlist')).toBe(false);
    expect(isResellerAllowedPath('/security-admin')).toBe(false);
    expect(isResellerAllowedPath('/security-admin/webauthnx')).toBe(false);
  });

  test('a bound user is refused the staff API whatever its permissions', async () => {
    const token = asBoundReseller(['clients.view', 'reseller_app.use']);
    const res = await get('/clients', token);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Reseller accounts can only use the reseller app');
  });

  test('a bound user still reaches /auth/me (with its binding) and the reseller app', async () => {
    const token = asBoundReseller();
    User.getOrganizations.mockResolvedValue([]);
    const me = await get('/auth/me', token);
    expect(me.status).toBe(200);
    expect(me.body.data.reseller_binding).toEqual({ reseller_id: 1, reseller_name: 'R1' });
    expect((await get('/reseller-app/me', token)).status).toBe(200);
  });

  test('org-level staff are not fenced and have no binding', async () => {
    const token = asOrgAdmin();
    User.getOrganizations.mockResolvedValue([]);
    const clients = await get('/clients', token);
    expect(clients.body?.error?.message).not.toBe('Reseller accounts can only use the reseller app');
    const me = await get('/auth/me', token);
    expect(me.body.data.reseller_binding).toBeNull();
  });

  test('a request without credentials is left to the route', async () => {
    const res = await request(app).get('/api/v1/clients');
    expect(res.status).toBe(401);
    expect(sqlCalls(/reseller_user_bindings/)).toHaveLength(0);
  });
});

describe('reseller escalation guards', () => {
  test('a bound user cannot create a sub-reseller with a commission or status', async () => {
    const token = asBoundReseller(['resellers.create', 'resellers.update']);
    const res = await post('/resellers', token, { name: 'Sub', parent_id: 1, commission_rate: 50 });
    expect(res.status).toBe(403);
    expect((await post('/resellers', token, { name: 'Sub', parent_id: 1, status: 'active' })).status).toBe(403);
    expect(sqlCalls(/INSERT INTO resellers/)).toHaveLength(0);
  });

  test('without those fields a sub-reseller gets commission 0 and status active', async () => {
    // The fence lets /resellers through; the scope and permissions decide.
    const token = asBoundReseller(['resellers.create']);
    const res = await post('/resellers', token, { name: 'Sub', parent_id: 1 });
    expect(res.status).toBe(201);
    const [[, params]] = sqlCalls(/INSERT INTO resellers/);
    expect(params.slice(0, 4)).toEqual([ORG, 1, 2, 'Sub']);
    expect(params[7]).toBe(0);
    expect(params[8]).toBe('active');
  });

  test('a bound user cannot raise a commission or change a status through PUT', async () => {
    const token = asBoundReseller(['resellers.update']);
    expect((await put('/resellers/3', token, { commission_rate: 90 })).status).toBe(403);
    expect((await put('/resellers/1', token, { status: 'active' })).status).toBe(403);
    expect(sqlCalls(/UPDATE resellers SET/)).toHaveLength(0);
  });

  test('PUT binds the organization in its UPDATE', async () => {
    const res = await put('/resellers/2', asOrgAdmin(), { name: 'R2b', commission_rate: 7 });
    expect(res.status).toBe(200);
    const [[sql, params]] = sqlCalls(/UPDATE resellers SET/);
    expect(sql).toMatch(/WHERE id = \? AND organization_id = \?/);
    expect(params.slice(-2)).toEqual(['2', ORG]);
  });
});

describe('allowed plans (org-level admin)', () => {
  test('PUT replaces the set in one transaction', async () => {
    allowedPlanIds = [10];
    const res = await put('/resellers/1/allowed-plans', asOrgAdmin(), { plan_ids: [11, 10, 11] });
    expect(res.status).toBe(200);
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.query.mock.calls[0]).toEqual([
      'DELETE FROM reseller_allowed_plans WHERE organization_id = ? AND reseller_id = ?', [ORG, 1],
    ]);
    expect(conn.query.mock.calls[1][1]).toEqual([ORG, 1, 11, ORG, 1, 10]);
    expect(conn.commit).toHaveBeenCalled();
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ tableName: 'reseller_allowed_plans', newValues: { plan_ids: [11, 10] } }));
  });

  test('an empty list clears the set', async () => {
    const res = await put('/resellers/1/allowed-plans', asOrgAdmin(), { plan_ids: [] });
    expect(res.status).toBe(200);
    expect(conn.query).toHaveBeenCalledTimes(1);
  });

  test('a plan outside the organization is 422 and nothing changes', async () => {
    const res = await put('/resellers/1/allowed-plans', asOrgAdmin(), { plan_ids: [10, 999] });
    expect(res.status).toBe(422);
    expect(conn.query).not.toHaveBeenCalled();
  });

  test('a sub-reseller has no set of its own: PUT is 422', async () => {
    const res = await put('/resellers/3/allowed-plans', asOrgAdmin(), { plan_ids: [10] });
    expect(res.status).toBe(422);
    expect(conn.query).not.toHaveBeenCalled();
  });

  test('GET lists them', async () => {
    allowedPlanIds = [11];
    const res = await get('/resellers/1/allowed-plans', asOrgAdmin());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ plan_id: 11, name: 'Hogar 50', price: 449 }]);
  });

  test('a bound user cannot read or change them', async () => {
    const token = asBoundReseller(['resellers.view', 'resellers.update']);
    expect((await get('/resellers/1/allowed-plans', token)).status).toBe(403);
    expect((await put('/resellers/1/allowed-plans', token, { plan_ids: [10] })).status).toBe(403);
    expect(conn.query).not.toHaveBeenCalled();
  });
});

describe('create a reseller login', () => {
  const body = { first_name: 'Rosa', last_name: 'Diaz', email: 'rosa@example.com', password: 'Segura123!', group_id: 1, role: 'admin' };

  test('creates a reseller_admin user and binds it in the same flow', async () => {
    User.findByEmail.mockResolvedValue(null);
    User.create.mockResolvedValue({ id: 42, email: 'rosa@example.com', organization_id: ORG });
    const res = await post('/resellers/1/users', asOrgAdmin(), body);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ user_id: 42, email: 'rosa@example.com', reseller_id: 1 });
    const created = User.create.mock.calls[0][0];
    expect(created).toMatchObject({ organization_id: ORG, first_name: 'Rosa', last_name: 'Diaz', email: 'rosa@example.com', group_id: 8, status: 'active' });
    expect(created).not.toHaveProperty('password');
    expect(created.password_hash).toMatch(/^\$2[aby]\$/);
    const [[, params]] = sqlCalls(/INSERT INTO reseller_user_bindings/);
    expect(params).toEqual([ORG, 42, 1, 7]);
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ tableName: 'users', recordId: 42 }));
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ tableName: 'reseller_user_bindings', recordId: 55 }));
  });

  test('an email already in use is 409', async () => {
    User.findByEmail.mockResolvedValue({ id: 3 });
    const res = await post('/resellers/1/users', asOrgAdmin(), body);
    expect(res.status).toBe(409);
    expect(User.create).not.toHaveBeenCalled();
  });

  test('the password policy applies', async () => {
    User.findByEmail.mockResolvedValue(null);
    const res = await post('/resellers/1/users', asOrgAdmin(), { ...body, password: 'short' });
    expect(res.status).toBe(422);
    expect(User.create).not.toHaveBeenCalled();
  });

  test('a failed binding archives the new user again', async () => {
    User.findByEmail.mockResolvedValue(null);
    User.create.mockResolvedValue({ id: 42, email: 'rosa@example.com' });
    User.delete.mockResolvedValue(true);
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO reseller_user_bindings/.test(String(sql))) throw new Error('db down');
      return base(sql, params);
    });
    const res = await post('/resellers/1/users', asOrgAdmin(), body);
    expect(res.status).toBe(500);
    expect(User.delete).toHaveBeenCalledWith(42, ORG);
  });

  test('needs users.create or point_logins.create, and org-level access', async () => {
    const token = asOrgAdmin();
    User.getPermissions.mockResolvedValue(['resellers.update']);
    expect((await post('/resellers/1/users', token, body)).status).toBe(403);
    // A manager creates reseller logins with point_logins.create alone.
    User.findByEmail.mockResolvedValue(null);
    User.create.mockResolvedValue({ id: 43, email: 'rosa@example.com' });
    User.getPermissions.mockResolvedValue(['resellers.update', 'point_logins.create']);
    expect((await post('/resellers/1/users', token, body)).status).toBe(201);
    expect(User.create.mock.calls[0][0]).toMatchObject({ group_id: 8 });
    User.create.mockClear();
    const bound = asBoundReseller(['resellers.update', 'users.create']);
    expect((await post('/resellers/1/users', bound, body)).status).toBe(403);
    expect(User.create).not.toHaveBeenCalled();
  });
});

describe('lead conversion keeps the reseller', () => {
  const lifecycleService = require('../src/services/lifecycleService');

  function conversionConn(lead, resellerRows) {
    return {
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      query: jest.fn(async (sql) => {
        if (/FROM leads/.test(sql)) return [[lead]];
        if (/FROM organizations/.test(sql)) return [[{ locale: 'global' }]];
        if (/FROM resellers/.test(sql)) return [resellerRows];
        if (/INSERT INTO clients/.test(sql)) return [{ insertId: 500 }];
        if (/UPDATE leads/.test(sql)) return [{ affectedRows: 1 }];
        return [[]];
      }),
    };
  }

  test('convertLead copies leads.reseller_id to the client', async () => {
    const c = conversionConn({ id: 900, organization_id: ORG, name: 'Carla', reseller_id: 1, converted_client_id: null }, [{ id: 1 }]);
    db.getConnection.mockResolvedValue(c);
    const result = await lifecycleService.convertLead(900, ORG);
    const insert = c.query.mock.calls.find(([sql]) => /INSERT INTO clients/.test(sql));
    expect(insert[0]).toMatch(/`reseller_id`/);
    expect(insert[1]).toContain(1);
    expect(result.client.reseller_id).toBe(1);
    const lookup = c.query.mock.calls.find(([sql]) => /FROM resellers/.test(sql));
    expect(lookup).toEqual([expect.stringMatching(/organization_id <=> \? AND deleted_at IS NULL/), [1, ORG]]);
  });

  test('a reseller no longer in the organization is not copied', async () => {
    const c = conversionConn({ id: 900, organization_id: ORG, name: 'Carla', reseller_id: 1, converted_client_id: null }, []);
    db.getConnection.mockResolvedValue(c);
    const result = await lifecycleService.convertLead(900, ORG);
    const insert = c.query.mock.calls.find(([sql]) => /INSERT INTO clients/.test(sql));
    expect(insert[0]).not.toMatch(/`reseller_id`/);
    expect(result.client.reseller_id).toBeNull();
  });
});

describe('staff lead list shows the reseller', () => {
  test('?reseller_id= filters the list and each row carries reseller_name', async () => {
    const token = asOrgAdmin(['leads.view']);
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      const s = String(sql);
      if (/^SELECT \* FROM `leads`/.test(s)) {
        return [[{ id: 900, name: 'Carla', reseller_id: 1 }, { id: 901, name: 'Dora', reseller_id: null }]];
      }
      if (/COUNT\(\*\) AS total FROM `leads`/.test(s)) return [[{ total: 2 }]];
      if (/SELECT id, name FROM resellers WHERE organization_id = \? AND id IN/.test(s)) return [[{ id: 1, name: 'R1' }]];
      return base(sql, params);
    });
    const res = await get('/leads?reseller_id=1', token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: 900, name: 'Carla', reseller_id: 1, reseller_name: 'R1' },
      { id: 901, name: 'Dora', reseller_id: null, reseller_name: null },
    ]);
    const [[sql, params]] = sqlCalls(/^SELECT \* FROM `leads`/);
    expect(sql).toMatch(/`reseller_id` = \?/);
    expect(params).toEqual(expect.arrayContaining([ORG, '1']));
    const [[, nameParams]] = sqlCalls(/FROM resellers WHERE organization_id = \? AND id IN/);
    expect(nameParams).toEqual([ORG, 1]);
  });
});

// =============================================================================
// Review follow-ups
// =============================================================================

// Returns only the columns a SELECT names (or the whole row for SELECT * /
// alias.*), the way MySQL would, so a test sees what the route really asks.
function project(sql, row) {
  const list = /SELECT\s+([\s\S]+?)\s+FROM\s/i.exec(String(sql))[1];
  const cols = list.split(',').map((c) => c.trim());
  if (cols.some((c) => c === '*' || /^\w+\.\*$/.test(c))) return { ...row };
  const out = {};
  for (const c of cols) {
    const name = (/\bAS\s+(\w+)$/i.exec(c) || [])[1] || c.split('.').pop();
    if (name in row) out[name] = row[name];
  }
  return out;
}

describe('reseller portal reads never return hashes or internal fields', () => {
  const SECRET_CLIENT = {
    id: 31, name: 'Ana', phone: '5550001', email: 'ana@example.com', status: 'active', reseller_id: 3,
    address: 'Calle 1', city: 'Toluca', created_at: '2026-01-01T00:00:00.000Z',
    portal_password_hash: '$2b$10$abcdefghijklmnopqrstuv', portal_reset_token_hash: 'f'.repeat(64),
    portal_reset_token_expires: '2026-01-02 00:00:00', portal_token_version: 3, curp: 'XEXX010101HNEXXXA4',
    notes: 'internal note', tax_id: 'XAXX010101000',
  };
  const SECRET_INVOICE = {
    id: 80, client_id: 31, contract_id: 70, invoice_number: 'F-1', issue_date: '2026-09-25', due_date: '2026-10-01',
    subtotal: '257.76', tax_amount: '41.24', total: '299.00', currency: 'MXN', status: 'overdue', paid_at: null,
    notes: 'internal invoice note', created_by: 4, version: 2, tax_rate_id: 1, client_name: 'Ana',
  };

  function withPortalRows() {
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      const s = String(sql);
      if (/^SELECT id FROM clients/.test(s.trim())) return [[{ id: 31 }]];
      if (/FROM clients WHERE organization_id = \? AND reseller_id IN/.test(s) && !/COUNT/.test(s)) {
        return [[project(s, SECRET_CLIENT)]];
      }
      if (/FROM invoices i/.test(s) && !/COUNT/.test(s)) return [[project(s, SECRET_INVOICE)]];
      if (/COUNT\(\*\) AS total/.test(s)) return [[{ total: 1 }]];
      return base(sql, params);
    });
  }

  test('GET /reseller-portal/:id/clients names safe columns only', async () => {
    withPortalRows();
    const token = asBoundReseller(['reseller_portal.manage_customers']);
    const res = await get('/reseller-portal/1/clients', token);
    expect(res.status).toBe(200);
    const [row] = res.body.data;
    expect(row).toMatchObject({ id: 31, name: 'Ana', status: 'active', reseller_id: 3 });
    for (const key of ['portal_password_hash', 'portal_reset_token_hash', 'portal_reset_token_expires', 'portal_token_version', 'curp', 'notes', 'tax_id']) {
      expect(row).not.toHaveProperty(key);
    }
  });

  test('GET /reseller-portal/:id/invoices names safe columns only and binds the organization', async () => {
    withPortalRows();
    const token = asBoundReseller(['reseller_portal.invoices']);
    const res = await get('/reseller-portal/1/invoices', token);
    expect(res.status).toBe(200);
    const [row] = res.body.data;
    expect(row).toMatchObject({ id: 80, invoice_number: 'F-1', total: '299.00', client_name: 'Ana' });
    for (const key of ['notes', 'created_by', 'version', 'tax_rate_id']) expect(row).not.toHaveProperty(key);
    const [[sql, params]] = sqlCalls(/FROM invoices i/).filter(([q]) => !/COUNT/.test(q));
    expect(sql).toMatch(/c\.organization_id = i\.organization_id/);
    expect(params[0]).toBe(ORG);
  });
});

describe('reseller feasibility is a summary, not the network inventory', () => {
  const { resellerFeasibilitySummary } = require('../src/routes/resellerApp');
  const STAFF_RESULT = {
    has_coordinates: true,
    latitude: 19.28,
    longitude: -99.65,
    coverage_zones: [
      { id: 5, name: 'Centro', zone_type: 'fiber', status: 'active', max_download_mbps: 200, max_upload_mbps: 50 },
      { id: 6, name: 'Norte', zone_type: 'fixed_wireless', status: 'planned', max_download_mbps: 30, max_upload_mbps: 10 },
    ],
    wireless: [{ device_id: 44, ap_name: 'Torre Cerro', latitude: '19.29', longitude: '-99.66', sector_azimuth_deg: 120, frequency_mhz: 5800, distance_km: 0.8 }],
    ftth: [{ id: 12, name: 'ODF-7', site_name: 'Nodo 1', latitude: '19.27', longitude: '-99.64', port_count: 48, ports_tracked: 48, free_ports: 3, distance_km: 2.4 }],
  };

  test('the route returns the summary without ids, names, coordinates or RF data', async () => {
    leadFeasibilityService.assess.mockResolvedValue(STAFF_RESULT);
    const res = await get('/reseller-app/leads/900/feasibility', asBoundReseller());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      has_coordinates: true,
      covered: true,
      coverage_zones: [{ name: 'Centro', zone_type: 'fiber', status: 'active', max_download_mbps: 200, max_upload_mbps: 50 }],
      zone_lookup_failed: false,
      wireless: { nearby: true, distance_band: 'under_1km' },
      ftth: { nearby: true, distance_band: 'under_3km', has_free_ports: true },
    });
    const text = JSON.stringify(res.body);
    for (const leak of ['Torre Cerro', 'ODF-7', 'Nodo 1', '5800', '-99.66', 'device_id', 'latitude']) expect(text).not.toContain(leak);
  });

  test('a zone that is planned, under construction or retired is not coverage', () => {
    for (const status of ['planned', 'under_construction', 'retired']) {
      const out = resellerFeasibilitySummary({ ...STAFF_RESULT, coverage_zones: [{ name: 'Z', zone_type: 'fiber', status }], wireless: [], ftth: [] });
      expect(out.covered).toBe(false);
      expect(out.coverage_zones).toEqual([]);
    }
    expect(resellerFeasibilitySummary({ ...STAFF_RESULT, coverage_zones: [{ name: 'Z', status: 'degraded' }] }).covered).toBe(true);
  });

  test('an AP or ODF frame far away is not nearby', () => {
    const out = resellerFeasibilitySummary({
      ...STAFF_RESULT,
      coverage_zones: [],
      wireless: [{ ap_name: 'Lejos', distance_km: 60 }],
      ftth: [{ name: 'Lejos', distance_km: 12.5, ports_tracked: 48, free_ports: 10 }],
    });
    expect(out).toMatchObject({
      covered: false,
      wireless: { nearby: false, distance_band: 'farther' },
      ftth: { nearby: false, distance_band: 'farther', has_free_ports: null },
    });
  });

  test('a zone lookup error is a flag, not the database error text', () => {
    const out = resellerFeasibilitySummary({ ...STAFF_RESULT, coverage_zones: [{ error: 'coverage zone lookup failed', detail: 'ER_GIS_INVALID_DATA at table x' }] });
    expect(out.zone_lookup_failed).toBe(true);
    expect(JSON.stringify(out)).not.toContain('ER_GIS');
  });

  test('no coordinates', () => {
    expect(resellerFeasibilitySummary({ has_coordinates: false, coverage_zones: [], wireless: [], ftth: [] })).toMatchObject({ has_coordinates: false, covered: false });
  });

  test('free ports are unknown when no nearby frame has registered ports', () => {
    const out = resellerFeasibilitySummary({ ...STAFF_RESULT, ftth: [{ distance_km: 0.5, ports_tracked: 0, free_ports: 0 }] });
    expect(out.ftth).toEqual({ nearby: true, distance_band: 'under_1km', has_free_ports: null });
  });
});

describe('overdue filter on the client list', () => {
  test('?overdue=1 adds the overdue condition to the list and the count', async () => {
    const res = await get('/reseller-app/clients?overdue=1', asBoundReseller());
    expect(res.status).toBe(200);
    const [[listSql, listParams]] = sqlCalls(/FROM clients c\s+WHERE c\.deleted_at IS NULL/).filter(([q]) => /balance_due/.test(q));
    const [[countSql, countParams]] = sqlCalls(/COUNT\(\*\) AS total FROM clients c/);
    for (const sql of [listSql, countSql]) expect(sql).toMatch(/AND EXISTS \(SELECT 1 FROM invoices i[\s\S]+i\.due_date < \?/);
    // where params: org, subtree, then the payable statuses and the business date
    expect(countParams.slice(0, 3)).toEqual([ORG, 1, 3]);
    expect(countParams).toHaveLength(3 + 3 + 1);
    expect(listParams.slice(-countParams.length)).toEqual(countParams);
  });

  test('without it the list is unfiltered, and a bad value is 422', async () => {
    const token = asBoundReseller();
    await get('/reseller-app/clients', token);
    const [[countSql]] = sqlCalls(/COUNT\(\*\) AS total FROM clients c/);
    expect(countSql).not.toMatch(/EXISTS/);
    expect((await get('/reseller-app/clients?overdue=maybe', token)).status).toBe(422);
  });
});

describe('ISP decisions about a reseller are org-level only', () => {
  // A binding is allowed for a user in any group, so a bound user may hold
  // these permissions; the binding still wins.
  const ALL = [
    'resellers.view', 'resellers.suspend', 'reseller_commissions.approve', 'reseller_plan_prices.manage',
    'reseller_ip_pool_allocations.manage', 'reseller_olt_port_assignments.manage',
    'reseller_bandwidth_quotas.manage', 'reseller_billing_entities.manage',
  ];
  const del = (path, token) => auth(request(app).delete(`/api/v1${path}`), token);

  test.each([
    ['post', '/resellers/1/suspend', {}],
    ['post', '/resellers/1/plan-prices', { plan_id: 10, custom_price: 1 }],
    ['delete', '/resellers/1/plan-prices/4', undefined],
    ['post', '/resellers/1/ip-pools', { ip_pool_id: 2 }],
    ['delete', '/resellers/1/ip-pools/4', undefined],
    ['put', '/resellers/1/bandwidth-quota', { max_download_mbps: 1000 }],
    ['post', '/resellers/1/olt-ports', { olt_port_id: 2 }],
    ['delete', '/resellers/1/olt-ports/4', undefined],
    ['put', '/resellers/1/billing-entity', { legal_name: 'X' }],
  ])('a bound user is refused %s %s', async (method, path, body) => {
    const token = asBoundReseller(ALL);
    const res = method === 'delete' ? await del(path, token)
      : method === 'put' ? await put(path, token, body) : await post(path, token, body);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only the ISP can change this for a reseller');
    expect(sqlCalls(/^\s*(UPDATE|INSERT|DELETE)\b/)).toHaveLength(0);
  });

  test('the commission approve route is gone for everyone (phase 4)', async () => {
    const bound = await post('/resellers/1/commissions/9/approve', asBoundReseller(ALL), { status: 'paid' });
    const staff = await post('/resellers/1/commissions/9/approve', asOrgAdmin(['reseller_commissions.approve']), { status: 'paid' });
    expect(bound.status).toBe(404);
    expect(staff.status).toBe(404);
    expect(sqlCalls(/^\s*(UPDATE|INSERT|DELETE)\b/)).toHaveLength(0);
  });

  test('org-level staff still suspend a reseller', async () => {
    const res = await post('/resellers/1/suspend', asOrgAdmin(['resellers.suspend']));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 1, status: 'suspended' });
  });
});

describe('real-time feeds refuse reseller-bound accounts', () => {
  const realtimeAccess = require('../src/services/realtimeAccess');

  test('resellerBound looks the binding up in the organization', async () => {
    binding = { reseller_id: 1, live_reseller_id: 1, reseller_name: 'R1' };
    expect(await realtimeAccess.resellerBound({ userId: 7, orgId: ORG })).toBe(true);
    const [[, params]] = sqlCalls(/FROM reseller_user_bindings b/);
    expect(params).toEqual([ORG, 7]);
    binding = undefined;
    expect(await realtimeAccess.resellerBound({ userId: 7, orgId: ORG })).toBe(false);
  });

  test('a validated global-access principal is not confined', async () => {
    binding = { reseller_id: 1, live_reseller_id: 1, reseller_name: 'R1' };
    expect(await realtimeAccess.resellerBound({ userId: 7, orgId: ORG, hasGlobalOrganizationAccess: true })).toBe(false);
  });

  test('a binding added while a stream is open ends it', async () => {
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/SELECT status, token_version FROM users/.test(String(sql))) return [[{ status: 'active', token_version: 0 }]];
      return base(sql, params);
    });
    expect(await realtimeAccess.stillAuthorized({ userId: 7, tokenVersion: 0, orgId: ORG })).toBe(true);
    binding = { reseller_id: 1, live_reseller_id: 1, reseller_name: 'R1' };
    expect(await realtimeAccess.stillAuthorized({ userId: 7, tokenVersion: 0, orgId: ORG })).toBe(false);
  });
});

describe('sign-ups are rate limited per reseller', () => {
  test('the limiter sits on POST /reseller-app/leads', () => {
    const { resellerSignupLimiter } = require('../src/middleware/rateLimit');
    const router = require('../src/routes/resellerApp');
    const layer = router.stack.find((l) => l.route && l.route.path === '/leads' && l.route.methods.post);
    expect(layer.route.stack.map((s) => s.handle)).toContain(resellerSignupLimiter);
  });
});
