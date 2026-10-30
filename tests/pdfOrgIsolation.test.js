// =============================================================================
// VigaBSS 5.0 — PDF exports and thermal receipts: organization + permission
// =============================================================================
// /pdf/* and the thermal-receipt routes used to load documents by id alone
// (no organization predicate) and /pdf/* had no permission check, so any staff
// login or API token in one organization could download another
// organization's invoices, credit notes, quotes, CFDI, payment receipts and
// client statements. These tests drive the real routers, RBAC middleware and
// generators against a database mock that holds every document in org 1.
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
    authorizationRole: 'billing',
    membershipRole: 'billing',
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
const app = require('../src/app');

const OWNER_ORG = 1;
const OTHER_ORG = 2;

const token = (orgId) => jwt.sign(
  { sub: 50, email: 'staff@isp.example', role: 'billing', orgId },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);

// Rows exist only in OWNER_ORG. A lookup returns a row only when it binds
// OWNER_ORG, so an unscoped lookup (old behaviour) would also return it.
const ROWS = {
  invoices: { id: 10, organization_id: OWNER_ORG, client_id: 3, invoice_number: 'F-10', total: '116.00', subtotal: '100.00', tax: '16.00', currency: 'MXN', status: 'sent', issue_date: '2026-10-01', due_date: '2026-10-15', name: 'Alice', org_name: 'ISP One', org_locale: 'US' },
  credit_notes: { id: 11, organization_id: OWNER_ORG, client_id: 3, credit_note_number: 'NC-11', total: '10.00', currency: 'MXN', status: 'issued', name: 'Alice', org_name: 'ISP One' },
  quotes: { id: 12, organization_id: OWNER_ORG, client_id: 3, quote_number: 'Q-12', total: '50.00', currency: 'MXN', status: 'sent', name: 'Alice', org_name: 'ISP One' },
  cfdi_documents: { id: 13, organization_id: OWNER_ORG, uuid: null, sat_status: 'draft', total: '116.00', org_name: 'ISP One' },
  payments: { id: 14, organization_id: OWNER_ORG, client_id: 3, amount: '116.00', currency: 'MXN', method: 'cash', payment_date: '2026-10-02', name: 'Alice', org_name: 'ISP One' },
  clients: { id: 3, organization_id: OWNER_ORG, name: 'Alice', email: 'alice@example.com', org_name: 'ISP One' },
};
const MAIN_LOOKUP = [
  [/FROM invoices i\b[\s\S]*WHERE i\.id = \?/, 'invoices'],
  [/FROM credit_notes cn\b[\s\S]*WHERE cn\.id = \?/, 'credit_notes'],
  [/FROM quotes q\b[\s\S]*WHERE q\.id = \?/, 'quotes'],
  [/FROM cfdi_documents cd\b[\s\S]*WHERE cd\.id = \?/, 'cfdi_documents'],
  [/FROM payments p\b[\s\S]*WHERE p\.id = \?/, 'payments'],
  [/FROM clients cl\b[\s\S]*WHERE cl\.id = \?/, 'clients'],
];

let granted;
let mainLookups;

beforeEach(() => {
  jest.clearAllMocks();
  granted = [];
  mainLookups = [];
  jest.spyOn(User, 'getPermissions').mockImplementation(async () => granted);
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM `?users`?\b/.test(sql)) {
      return [[{ id: 50, email: 'staff@isp.example', role: 'billing', status: 'active', organization_id: OWNER_ORG }]];
    }
    for (const [re, table] of MAIN_LOOKUP) {
      if (re.test(sql)) {
        mainLookups.push({ table, sql, params });
        const bindsOwner = /organization_id (<=>|=) \?/.test(sql) && params.includes(OWNER_ORG);
        const unscoped = !/organization_id (<=>|=) \?/.test(sql);
        return [[...(bindsOwner || unscoped ? [ROWS[table]] : [])]];
      }
    }
    if (/COALESCE\(SUM/.test(sql)) return [[{ opening: '0' }]];
    return [[]];
  });
});

afterEach(() => jest.restoreAllMocks());

const PDF_ROUTES = [
  ['/api/v1/pdf/invoices/10', 'invoices.view'],
  ['/api/v1/pdf/credit-notes/11', 'credit_notes.view'],
  ['/api/v1/pdf/quotes/12', 'quotes.view'],
  ['/api/v1/pdf/cfdi/13', 'cfdi_documents.view'],
  ['/api/v1/pdf/payments/14', 'payments.view'],
  ['/api/v1/pdf/clients/3/ledger', 'clients.view'],
];
const RECEIPT_ROUTES = [
  ['/api/v1/invoices/10/receipt', 'invoices.view'],
  ['/api/v1/payments/14/receipt', 'payments.view'],
];

describe.each([...PDF_ROUTES, ...RECEIPT_ROUTES])('GET %s', (path, slug) => {
  test(`another organization gets 404 even with ${slug}`, async () => {
    granted = [slug];
    const res = await request(app).get(path).set('Authorization', `Bearer ${token(OTHER_ORG)}`);
    expect(res.status).toBe(404);
    expect(mainLookups.length).toBeGreaterThan(0);
    expect(mainLookups[0].params).toContain(OTHER_ORG);
  });

  test(`the owning organization with ${slug} gets the document`, async () => {
    granted = [slug];
    const res = await request(app).get(path).set('Authorization', `Bearer ${token(OWNER_ORG)}`);
    expect(res.status).toBe(200);
  });
});

describe.each(PDF_ROUTES)('GET %s permission', (path, slug) => {
  test(`a same-org user without ${slug} gets 403 and nothing is loaded`, async () => {
    granted = ['tickets.view', 'work_orders.view'];
    const res = await request(app).get(path).set('Authorization', `Bearer ${token(OWNER_ORG)}`);
    expect(res.status).toBe(403);
    expect(mainLookups).toHaveLength(0);
  });
});
