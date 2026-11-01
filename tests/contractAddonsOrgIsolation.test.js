// =============================================================================
// VigaBSS 5.0 — Contract add-ons: organization isolation (TNA-05)
// =============================================================================
// POST /contracts/:id/addons used to INSERT contract_addons straight from the
// path id and body with no check that the contract or the plan_addon belonged
// to the caller's organization, so one tenant could bill another tenant's
// contract on its next invoice run. GET /contracts/:id/addons returned any
// tenant's add-ons and prices by id. These tests drive the real routers and
// RBAC middleware against a database mock that holds the contract in org 1,
// plus a billingService check that out-of-window add-ons never bill.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

// The caller is an ordinary (non-global) user in whatever org the token names.
jest.mock('../src/services/orgPrincipalService', () => ({
  resolveOrgPrincipal: jest.fn(async (_user, organizationId) => ({
    authorizationRole: 'admin',
    membershipRole: 'admin',
    organizationId: Number(organizationId),
    isInstallOperator: false,
    isSuperAdmin: false,
    hasGlobalOrganizationAccess: false,
  })),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');
const billingService = require('../src/services/billingService');
const app = require('../src/app');

const OWNER_ORG = 1;
const OTHER_ORG = 2;
const CONTRACT_ID = 2001;
const OWN_ADDON_ID = 31; // org 1 catalog row
const FOREIGN_ADDON_ID = 32; // org 2 catalog row

const token = (orgId) => jwt.sign(
  { sub: 50, email: 'staff@isp.example', role: 'admin', orgId },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);

const CONTRACT = { id: CONTRACT_ID, organization_id: OWNER_ORG, client_id: 3, plan_id: 7, status: 'active' };
const PLAN_ADDONS = {
  [OWN_ADDON_ID]: { id: OWN_ADDON_ID, organization_id: OWNER_ORG },
  [FOREIGN_ADDON_ID]: { id: FOREIGN_ADDON_ID, organization_id: OTHER_ORG },
};
const ADDON_ROW = { id: 900, contract_id: CONTRACT_ID, plan_addon_id: OWN_ADDON_ID, unit_price: '99.00', quantity: 1, addon_name: 'IP Estática' };

let granted;
let inserts;

beforeEach(() => {
  jest.clearAllMocks();
  granted = [];
  inserts = [];
  jest.spyOn(User, 'getPermissions').mockImplementation(async () => granted);
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM `?users`?\b/.test(sql)) {
      return [[{ id: 50, email: 'staff@isp.example', role: 'admin', status: 'active', organization_id: OWNER_ORG }]];
    }
    // Contract.findById(id, orgId) — returns the row only when org 1 is bound;
    // an unscoped lookup would also return it.
    if (/^SELECT \* FROM `contracts` WHERE id = \?/.test(sql)) {
      const scoped = /organization_id = \?/.test(sql);
      return [[...(!scoped || params.includes(OWNER_ORG) ? [CONTRACT] : [])]];
    }
    if (/FROM plan_addons\b/.test(sql) && /WHERE id = \?/.test(sql)) {
      const row = PLAN_ADDONS[params[0]];
      const ok = row && (row.organization_id === params[1] || row.organization_id === null);
      return [[...(ok ? [{ id: row.id }] : [])]];
    }
    if (/INSERT INTO contract_addons/.test(sql)) {
      inserts.push({ sql, params });
      return [{ insertId: 900 }];
    }
    if (/SELECT \* FROM contract_addons WHERE id = \?/.test(sql)) return [[ADDON_ROW]];
    if (/FROM contract_addons ca/.test(sql)) {
      // Contract.getAddons: rows only when the parent-contract org join binds org 1.
      const scoped = /c\.organization_id <=> \?/.test(sql);
      return [[...(!scoped || params.includes(OWNER_ORG) ? [ADDON_ROW] : [])]];
    }
    return [[]];
  });
});

afterEach(() => jest.restoreAllMocks());

const addonBody = (planAddonId) => ({ plan_addon_id: planAddonId, unit_price: 1000, quantity: 1, start_date: '2026-10-01' });

describe('POST /api/v1/contracts/:id/addons', () => {
  test('another organization gets 404 for a foreign contract and nothing is inserted', async () => {
    granted = ['contracts.update'];
    const res = await request(app)
      .post(`/api/v1/contracts/${CONTRACT_ID}/addons`)
      .set('Authorization', `Bearer ${token(OTHER_ORG)}`)
      .send(addonBody(FOREIGN_ADDON_ID));
    expect(res.status).toBe(404);
    expect(inserts).toHaveLength(0);
  });

  test('the owning organization gets 422 for another organization\'s catalog add-on', async () => {
    granted = ['contracts.update'];
    const res = await request(app)
      .post(`/api/v1/contracts/${CONTRACT_ID}/addons`)
      .set('Authorization', `Bearer ${token(OWNER_ORG)}`)
      .send(addonBody(FOREIGN_ADDON_ID));
    expect(res.status).toBe(422);
    expect(inserts).toHaveLength(0);
  });

  test('the owning organization can attach its own catalog add-on', async () => {
    granted = ['contracts.update'];
    const res = await request(app)
      .post(`/api/v1/contracts/${CONTRACT_ID}/addons`)
      .set('Authorization', `Bearer ${token(OWNER_ORG)}`)
      .send(addonBody(OWN_ADDON_ID));
    expect(res.status).toBe(201);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[0]).toBe(String(CONTRACT_ID));
  });

  test('a global (NULL-org) catalog add-on is still accepted', async () => {
    granted = ['contracts.update'];
    PLAN_ADDONS[77] = { id: 77, organization_id: null };
    try {
      const res = await request(app)
        .post(`/api/v1/contracts/${CONTRACT_ID}/addons`)
        .set('Authorization', `Bearer ${token(OWNER_ORG)}`)
        .send(addonBody(77));
      expect(res.status).toBe(201);
    } finally {
      delete PLAN_ADDONS[77];
    }
  });
});

describe('GET /api/v1/contracts/:id/addons', () => {
  test('another organization with contracts.view gets 404, not the add-on list', async () => {
    granted = ['contracts.view'];
    const res = await request(app)
      .get(`/api/v1/contracts/${CONTRACT_ID}/addons`)
      .set('Authorization', `Bearer ${token(OTHER_ORG)}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('99.00');
  });

  test('the owning organization gets its add-ons', async () => {
    granted = ['contracts.view'];
    const res = await request(app)
      .get(`/api/v1/contracts/${CONTRACT_ID}/addons`)
      .set('Authorization', `Bearer ${token(OWNER_ORG)}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('Contract.getAddons', () => {
  test('scopes through the parent contract organization', async () => {
    const Contract = require('../src/models/Contract');
    expect(await Contract.getAddons(CONTRACT_ID, OTHER_ORG)).toEqual([]);
    expect(await Contract.getAddons(CONTRACT_ID, OWNER_ORG)).toHaveLength(1);
  });
});

describe('billingService.generateInvoice add-on window', () => {
  test('pre-dated, expired and soft-deleted add-ons are not billed', async () => {
    jest.spyOn(Organization, 'getLocale').mockResolvedValue('global');
    // Candidate rows the add-on SELECT could return; the mock applies only the
    // predicates the SQL actually carries, as MySQL would.
    const candidates = [
      { id: 1, addon_name: 'In window', unit_price: '10.00', quantity: 1, start_date: '2026-01-01', end_date: null, deleted_at: null },
      { id: 2, addon_name: 'Expired', unit_price: '20.00', quantity: 1, start_date: '2026-01-01', end_date: '2026-09-30', deleted_at: null },
      { id: 3, addon_name: 'Pre-dated', unit_price: '30.00', quantity: 1, start_date: '2026-11-15', end_date: null, deleted_at: null },
      { id: 4, addon_name: 'Deleted', unit_price: '40.00', quantity: 1, start_date: '2026-01-01', end_date: null, deleted_at: '2026-05-01' },
    ];
    const conn = {
      beginTransaction: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
      query: jest.fn().mockResolvedValue([[{ id: 6 }]]),
      execute: jest.fn(async (sql, params = []) => {
        if (/FROM billing_periods/.test(sql)) return [[{ id: 10, status: 'pending' }]];
        if (/tax_exempt/.test(sql)) return [[{ tax_exempt: 0 }]];
        if (/INSERT INTO invoices\b/.test(sql)) return [{ insertId: 50 }];
        if (/FROM contract_addons ca/.test(sql)) {
          // The window is the billing period: start_date <= period_end and
          // end_date >= period_start, bound as params 1 and 2.
          const [, periodEnd, periodStart] = params;
          return [candidates.filter((r) => {
            if (/ca\.end_date >= \?/.test(sql) && r.end_date && r.end_date < periodStart) return false;
            if (/ca\.start_date <= \?/.test(sql) && r.start_date > periodEnd) return false;
            if (/ca\.deleted_at IS NULL/.test(sql) && r.deleted_at) return false;
            return true;
          })];
        }
        if (/^\s*SELECT/.test(sql)) return [[]];
        return [{ affectedRows: 1 }];
      }),
    };
    db.getConnection.mockResolvedValue(conn);
    db.query.mockResolvedValue([[{ id: 50 }]]);

    await billingService.generateInvoice(
      { id: 10, period_start: '2026-10-01', period_end: '2026-10-31' },
      { id: CONTRACT_ID, client_id: 3, price_override: null },
      { name: 'Basic', price: '100.00', currency: 'MXN' },
      OWNER_ORG,
    );

    const billed = conn.execute.mock.calls
      .filter(([sql]) => /INSERT INTO invoice_items/.test(sql))
      .map(([, params]) => params[1]);
    expect(billed).toContain('In window');
    expect(billed).not.toContain('Expired');
    expect(billed).not.toContain('Pre-dated');
    expect(billed).not.toContain('Deleted');
  });
});
