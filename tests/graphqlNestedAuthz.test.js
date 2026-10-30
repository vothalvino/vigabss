// =============================================================================
// VigaBSS 5.0 — GraphQL nested-field authorization (audit SEC-06)
// =============================================================================
// Root fields were guarded, but nested type fields only filtered by org: a
// technician/support user (clients.view, no invoices.view/payments.view) or an
// API token scoped to clients.view read every invoice and payment through
// clients{invoices payments}, and billing-category tickets through
// ticket(id)/tickets. Each nested edge now requires the slug of the REST route
// that serves the same data, returning []/null (no error, so ClientDetail does
// not blank) to a caller without it. The tenant `role = 'admin'` shortcut is
// gone: only a validated global-access principal bypasses, never an API token.
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

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { graphql } = require('graphql');
const { createSchema } = require('graphql-yoga');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const app = require('../src/app');
const typeDefs = require('../src/graphql/typeDefs');
const resolvers = require('../src/graphql/resolvers');
const { guardResolvers, NESTED_FIELD_PERMISSIONS } = require('../src/graphql');

const CLIENT = {
  id: 10, organization_id: 1, name: 'Acme', email: 'a@x.test', client_type: 'residential',
  status: 'active', created_at: '2026-01-01T00:00:00.000Z',
};
const CONTRACT = {
  id: 20, client_id: 10, organization_id: 1, status: 'active', created_at: '2026-01-01T00:00:00.000Z',
};
const INVOICE = {
  id: 30, client_id: 10, contract_id: 20, organization_id: 1, invoice_number: 'INV-1',
  subtotal: '100.00', tax_amount: '16.00', total: '116.00', currency: 'MXN', status: 'issued',
  created_at: '2026-01-02T00:00:00.000Z',
};
const PAYMENT = {
  id: 40, client_id: 10, organization_id: 1, amount: '116.00', currency: 'MXN',
  payment_method: 'cash', status: 'completed', created_at: '2026-01-03T00:00:00.000Z',
};
const DEVICE = { id: 50, contract_id: 20, organization_id: 1, name: 'CPE-1' };
const BILLING_TICKET = {
  id: 60, client_id: 10, organization_id: 1, subject: 'Refund', category: 'billing',
  status: 'open', priority: 'low', created_at: '2026-01-04T00:00:00.000Z', updated_at: '2026-01-04T00:00:00.000Z',
};
const TECH_TICKET = { ...BILLING_TICKET, id: 61, subject: 'Down', category: 'technical' };

/** Route every SQL statement to a fixture; record the SQL for assertions. */
function installDb() {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/FROM\s+`?tickets`?/.test(s)) {
      if (/WHERE id = \?/.test(s) || /`id` = \?/.test(s)) return [[BILLING_TICKET]];
      return [/category <> 'billing'/.test(s) ? [TECH_TICKET] : [BILLING_TICKET, TECH_TICKET]];
    }
    if (/FROM\s+payment_allocations/.test(s)) return [[{ id: 70, payment_id: 40, invoice_id: 30, amount: '116.00' }]];
    if (/FROM\s+`?invoices`?/.test(s)) return [[INVOICE]];
    if (/FROM\s+`?payments`?/.test(s)) return [[PAYMENT]];
    if (/FROM\s+`?contracts`?/.test(s)) return [[CONTRACT]];
    if (/FROM\s+`?devices`?|FROM devices d/.test(s)) return [[DEVICE]];
    if (/FROM\s+`?clients`?/.test(s)) return [[CLIENT]];
    return [[]];
  });
}

function tokenFor(role) {
  return jwt.sign({ sub: 1, email: `${role}@example.com`, role, orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
}

function asPersona(role, permissions) {
  User.findById.mockResolvedValue({
    id: 1, email: `${role}@example.com`, status: 'active', role, organization_id: 1,
  });
  User.getPermissions.mockResolvedValue(permissions);
}

function gqlHttp(role, query) {
  return request(app)
    .post('/api/v1/graphql')
    .set('Authorization', `Bearer ${tokenFor(role)}`)
    .send({ query });
}

// Seeded technician/support grants (migration 119/394): no invoices.view,
// payments.view or tickets.view_billing.
const TECHNICIAN = ['clients.view', 'contracts.view', 'tickets.view', 'devices.view'];
const BILLING = ['clients.view', 'contracts.view', 'invoices.view', 'payments.view', 'tickets.view', 'tickets.view_billing'];

const CLIENTS_QUERY = '{ clients(limit: 200) { id name invoices { id total } payments { id amount } contracts { id } devices { id } } }';

beforeEach(() => {
  jest.resetAllMocks();
  installDb();
});

describe('SEC-06 — HTTP: nested financial fields follow REST permissions', () => {
  test('technician reads clients but gets empty invoices/payments (no error, page does not blank)', async () => {
    asPersona('technician', TECHNICIAN);
    const res = await gqlHttp('technician', CLIENTS_QUERY);
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const [c] = res.body.data.clients;
    expect(c.name).toBe('Acme');
    expect(c.invoices).toEqual([]);
    expect(c.payments).toEqual([]);
    // Edges the technician does hold still resolve.
    expect(c.contracts).toEqual([{ id: '20' }]);
    expect(c.devices).toEqual([{ id: '50' }]);
    // No invoice/payment SQL ran at all.
    const sqls = db.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((s) => /FROM invoices/.test(s))).toBe(false);
    expect(sqls.some((s) => /FROM payments/.test(s))).toBe(false);
  });

  test('billing persona still reads invoices and payments through clients', async () => {
    asPersona('billing', BILLING);
    const res = await gqlHttp('billing', CLIENTS_QUERY);
    expect(res.body.errors).toBeUndefined();
    const [c] = res.body.data.clients;
    expect(c.invoices).toEqual([{ id: '30', total: '116.00' }]);
    expect(c.payments).toEqual([{ id: '40', amount: '116.00' }]);
    expect(c.devices).toEqual([]); // billing has no devices.view
  });

  test('Contract.invoices is hidden from a contracts.view-only caller', async () => {
    asPersona('technician', TECHNICIAN);
    const res = await gqlHttp('technician', '{ contract(id: 20) { id invoices { id } client { id } } }');
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.contract).toEqual({ id: '20', invoices: [], client: { id: '10' } });
  });

  test('technician cannot read a billing ticket via ticket(id)', async () => {
    asPersona('technician', TECHNICIAN);
    const res = await gqlHttp('technician', '{ ticket(id: 60) { id category } }');
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.ticket).toBeNull();
  });

  test('technician tickets list excludes the billing category in SQL', async () => {
    asPersona('technician', TECHNICIAN);
    const res = await gqlHttp('technician', '{ tickets { id category } }');
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.tickets).toEqual([{ id: '61', category: 'technical' }]);
  });

  test('billing persona keeps billing tickets', async () => {
    asPersona('billing', BILLING);
    const one = await gqlHttp('billing', '{ ticket(id: 60) { id category } }');
    expect(one.body.data.ticket).toEqual({ id: '60', category: 'billing' });
    const list = await gqlHttp('billing', '{ tickets { id } }');
    expect(list.body.data.tickets.map((t) => t.id)).toEqual(['60', '61']);
  });

  test('the permission set is resolved once per request, not per nested field', async () => {
    asPersona('technician', TECHNICIAN);
    db.query.mockImplementation(async (sql) => {
      if (/FROM\s+`?clients`?/.test(String(sql))) return [[CLIENT, { ...CLIENT, id: 11 }, { ...CLIENT, id: 12 }]];
      return [[]];
    });
    await gqlHttp('technician', CLIENTS_QUERY);
    expect(User.getPermissions).toHaveBeenCalledTimes(1);
  });
});

// Schema-level execution with an explicit principal: covers API tokens and
// every guarded edge without the HTTP auth plumbing.
describe('SEC-06 — schema: API-token scopes and every guarded edge', () => {
  const schema = createSchema({ typeDefs, resolvers: guardResolvers(resolvers) });
  const run = (source, user) => graphql({ schema, source, contextValue: { user, orgId: 1 } });

  test('an API token scoped to clients:read gets no invoices/payments even when its owner could', async () => {
    User.getPermissions.mockResolvedValue(BILLING); // owner is billing
    const token = { id: 1, organizationId: 1, role: 'admin', apiTokenId: 9, scopes: ['clients:read'] };
    const res = await run('{ clients { id invoices { id } payments { id } } }', token);
    expect(res.errors).toBeUndefined();
    expect(res.data.clients[0]).toEqual({ id: '10', invoices: [], payments: [] });
  });

  test('an API token never inherits the global-access bypass', async () => {
    User.getPermissions.mockResolvedValue(['clients.view']);
    const token = {
      id: 1, organizationId: 1, hasGlobalOrganizationAccess: true, apiTokenId: 9,
      scopes: ['clients:read', 'invoices:read'],
    };
    const res = await run('{ clients { id invoices { id } } }', token);
    expect(res.data.clients[0].invoices).toEqual([]);
  });

  test('a validated global-access principal reads every edge', async () => {
    const op = { id: 1, organizationId: 1, hasGlobalOrganizationAccess: true };
    const res = await run('{ clients { invoices { id } payments { id } } }', op);
    expect(res.errors).toBeUndefined();
    expect(res.data.clients[0].invoices).toHaveLength(1);
    expect(User.getPermissions).not.toHaveBeenCalled();
  });

  test('a tenant role=admin user resolves through the permission graph (no shortcut)', async () => {
    // Production path: with a real primary-context primitive the query-only
    // test-double compatibility shortcut (rbac.js#isLegacyTestAdmin) is off.
    db.withPrimaryContext = (cb) => cb();
    try {
      User.getPermissions.mockResolvedValue(['clients.view']); // admin-kind group without invoices.view
      const admin = { id: 1, organizationId: 1, role: 'admin' };
      const nested = await run('{ clients { id invoices { id } } }', admin);
      expect(nested.errors).toBeUndefined();
      expect(nested.data.clients[0].invoices).toEqual([]);
      const root = await run('{ invoices { id } }', admin);
      expect(root.errors[0].extensions.code).toBe('FORBIDDEN');
    } finally {
      delete db.withPrimaryContext;
    }
  });

  test('Invoice.appliedPayments, Payment.allocations and PaymentAllocation.invoice are gated', async () => {
    // invoices.view only: invoice visible, payments hidden.
    User.getPermissions.mockResolvedValue(['invoices.view']);
    const user = { id: 1, organizationId: 1, role: 'billing' };
    const inv = await run('{ invoice(id: 30) { id appliedPayments { id } client { id } } }', user);
    expect(inv.errors).toBeUndefined();
    expect(inv.data.invoice).toEqual({ id: '30', appliedPayments: [], client: null });

    // payments.view only: payment visible, allocation's invoice hidden.
    const ctxUser = { id: 1, organizationId: 1, role: 'billing' };
    User.getPermissions.mockResolvedValue(['payments.view']);
    const pay = await run('{ payment(id: 40) { id client { id } allocations { id invoice { id } } } }', ctxUser);
    expect(pay.errors).toBeUndefined();
    expect(pay.data.payment).toEqual({ id: '40', client: null, allocations: [{ id: '70', invoice: null }] });
  });

  test('Ticket.client requires clients.view', async () => {
    User.getPermissions.mockResolvedValue(['tickets.view', 'tickets.view_billing']);
    const res = await run('{ ticket(id: 60) { id client { id } } }', { id: 1, organizationId: 1, role: 'support' });
    expect(res.errors).toBeUndefined();
    expect(res.data.ticket).toEqual({ id: '60', client: null });
  });

  test('every guarded nested field exists and is wrapped', () => {
    const guarded = guardResolvers(resolvers);
    for (const [type, fields] of Object.entries(NESTED_FIELD_PERMISSIONS)) {
      for (const field of Object.keys(fields)) {
        expect(typeof resolvers[type][field]).toBe('function');
        expect(guarded[type][field]).not.toBe(resolvers[type][field]);
      }
    }
  });
});
