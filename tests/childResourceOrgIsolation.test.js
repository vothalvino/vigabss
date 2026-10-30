// =============================================================================
// VigaBSS 5.0 — Child resources must prove their parent is in the caller's org
// =============================================================================
// Contacts, credit-note / invoice / quote / factura-pública items, payment
// allocations, CFDI conceptos/related, inventory stock, subscriber
// certificates, device-group members and CPE profiles used to be read and
// written by PARENT id alone: the child tables carry no organization_id, and
// the handlers never loaded the parent with req.orgId. Any staff user in one
// organization could read or write another organization's rows by guessing
// an id. These tests drive the real routers, auth and RBAC middleware against
// an in-memory database fake in which every row belongs to OWNER_ORG.
//
// The fake answers an org-bound statement only with rows of the bound org, and
// an UNSCOPED statement (no organization_id predicate at all) with every row —
// exactly what MySQL would do, so the pre-fix code leaks here as it did live.
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
const Organization = require('../src/models/Organization');
const Invoice = require('../src/models/Invoice');
const Quote = require('../src/models/Quote');
const Client = require('../src/models/Client');
const billingService = require('../src/services/billingService');
const resolvers = require('../src/graphql/resolvers');
const app = require('../src/app');

// Org ids that cannot collide with any row id or numeric body value below.
const OWNER_ORG = 1001;
const OTHER_ORG = 2002;

const token = (orgId) => jwt.sign(
  { sub: 50, email: 'staff@isp.example', role: 'billing', orgId },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);

// Parent tables: rows are additionally filtered by the id the statement binds.
const PARENT_TABLES = new Set([
  'clients', 'credit_notes', 'payments', 'invoices', 'cfdi_documents', 'quotes',
  'factura_publica_invoices', 'inventory_items', 'subscriber_certificates',
  'radius', 'device_groups', 'devices', 'cpe_profiles',
]);

// Child rows carry the PARENT's organization_id so a statement that joins the
// parent and binds its org filters them correctly.
function freshFixtures() {
  return {
    clients: [{ id: 3, organization_id: OWNER_ORG, name: 'Alice' }],
    contacts: [{ id: 300, client_id: 3, first_name: 'Ann', last_name: 'Lee', organization_id: OWNER_ORG }],
    credit_notes: [
      { id: 11, organization_id: OWNER_ORG, status: 'draft' },
      { id: 16, organization_id: OTHER_ORG, status: 'draft' },
    ],
    credit_note_items: [{ id: 310, credit_note_id: 11, description: 'Refund', organization_id: OWNER_ORG }],
    payments: [{ id: 14, organization_id: OWNER_ORG, amount: '5.00' }],
    payment_allocations: [{ id: 320, payment_id: 14, invoice_id: 10, amount: '5.00', organization_id: OWNER_ORG }],
    invoices: [
      { id: 10, organization_id: OWNER_ORG, client_id: 3, invoice_number: 'F-10', status: 'draft', tax_rate: '0.0000', total: '0.00', currency: 'MXN' },
      { id: 15, organization_id: OTHER_ORG, client_id: 9, invoice_number: 'B-15', status: 'draft', tax_rate: '0.0000', total: '0.00', currency: 'MXN' },
    ],
    invoice_items: [{ id: 330, invoice_id: 10, description: 'Plan', organization_id: OWNER_ORG }],
    cfdi_documents: [{ id: 13, organization_id: OWNER_ORG, sat_status: 'vigente' }],
    cfdi_conceptos: [{ id: 340, cfdi_document_id: 13, descripcion: 'Internet', organization_id: OWNER_ORG }],
    cfdi_related_documents: [{ id: 341, cfdi_document_id: 13, uuid: 'U-1', organization_id: OWNER_ORG }],
    quotes: [{ id: 12, organization_id: OWNER_ORG, tax_rate: '0.0000' }],
    quote_items: [{ id: 350, quote_id: 12, description: 'Setup', organization_id: OWNER_ORG }],
    factura_publica_invoices: [{ id: 20, organization_id: OWNER_ORG, status: 'draft', cfdi_document_id: null }],
    factura_publica_invoice_items: [{ id: 360, factura_publica_invoice_id: 20, invoice_id: 10, organization_id: OWNER_ORG }],
    inventory_items: [{ id: 30, organization_id: OWNER_ORG, name: 'ONU' }],
    inventory_stock: [{ id: 370, item_id: 30, warehouse_id: 1, quantity: 4, warehouse_name: 'Main', organization_id: OWNER_ORG }],
    subscriber_certificates: [{ id: 50, organization_id: OWNER_ORG, client_id: 3, radius_account_id: 40, status: 'active', common_name: 'alice' }],
    radius: [{ id: 40, organization_id: OWNER_ORG, client_id: 3, username: 'alice' }],
    device_groups: [{ id: 60, organization_id: OWNER_ORG, name: 'Core' }],
    devices: [
      { id: 70, organization_id: OWNER_ORG, name: 'R1' },
      { id: 71, organization_id: OTHER_ORG, name: 'B1' },
    ],
    device_group_members: [{ device_group_id: 60, device_id: 70, id: 70, name: 'R1', organization_id: OWNER_ORG }],
    cpe_profiles: [
      { id: 80, organization_id: OWNER_ORG, parent_profile_id: null, wifi_ssid_template: 'Own', wifi_security: 'WPA2', parameters: null },
      { id: 81, organization_id: null, parent_profile_id: null, wifi_ssid_template: 'Global', parameters: null },
    ],
    cpe_parameter_mappings: [{ id: 380, cpe_profile_id: 80, organization_id: OWNER_ORG, source_type: 'static', static_value: 'psk-secret', parameter_path: 'Device.WiFi.PSK' }],
  };
}

let FIX;
let granted;
let writes;
let liveCfdi;

function tableOf(sql) {
  const s = sql.replace(/`/g, '');
  let m = s.match(/^\s*INSERT\s+(?:IGNORE\s+)?INTO\s+(\w+)/i);
  if (m) return { table: m[1], write: true };
  m = s.match(/^\s*UPDATE\s+(\w+)/i);
  if (m) return { table: m[1], write: true };
  m = s.match(/^\s*DELETE\s+(?:\w+\s+)?FROM\s+(\w+)/i);
  if (m) return { table: m[1], write: true };
  m = s.match(/\bFROM\s+(\w+)/i);
  return m ? { table: m[1], write: false } : { table: null, write: false };
}

function boundOrg(sql, params) {
  if (!/organization_id\s*(<=>|=)\s*\?/.test(sql)) return undefined; // unscoped
  if (params.includes(OWNER_ORG)) return OWNER_ORG;
  if (params.includes(OTHER_ORG)) return OTHER_ORG;
  return null;
}

async function respond(sql, params = []) {
  if (/FROM `?users`?\b/.test(sql)) {
    return [[{ id: 50, email: 'staff@isp.example', role: 'billing', status: 'active', organization_id: OWNER_ORG }]];
  }
  const { table, write } = tableOf(sql);
  const org = boundOrg(sql, params);
  const allowsGlobal = /organization_id IS NULL/.test(sql);

  if (write) {
    writes.push({ table, sql, params });
    const scopedMiss = org !== undefined && org !== OWNER_ORG;
    return [{ insertId: 900, affectedRows: scopedMiss ? 0 : 1 }];
  }
  // Fiscal-freeze probes: no live CFDI unless a test says so.
  if (table === 'cfdi_documents' && /sat_status IN/.test(sql)) {
    return [[...(liveCfdi ? [{ id: 13, sat_status: 'vigente' }] : [])]];
  }
  if (/COUNT\(\*\)/i.test(sql) && table) {
    const rows = (FIX[table] || []).filter((r) => org === undefined || r.organization_id === org);
    return [[{ total: rows.length }]];
  }
  if (!table || !FIX[table]) return [[]];

  let rows = FIX[table].filter((r) => org === undefined
    || r.organization_id === org
    || (allowsGlobal && r.organization_id === null));
  if (PARENT_TABLES.has(table)) {
    const bound = new Set(params.map(String));
    rows = rows.filter((r) => bound.has(String(r.id)));
  }
  if (table === 'factura_publica_invoice_items' && /WHERE id = \?/.test(sql)) {
    rows = [{ id: 900, factura_publica_invoice_id: params[0], invoice_id: 10 }];
  }
  return [rows];
}

function conn() {
  return {
    execute: jest.fn(respond),
    query: jest.fn(respond),
    beginTransaction: jest.fn(async () => {}),
    commit: jest.fn(async () => {}),
    rollback: jest.fn(async () => {}),
    release: jest.fn(),
  };
}

beforeAll(() => {
  config.features.snmp = true;
  config.features.cfdi = true;
  config.features.radius = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  FIX = freshFixtures();
  granted = [];
  writes = [];
  liveCfdi = false;
  jest.spyOn(User, 'getPermissions').mockImplementation(async () => granted);
  jest.spyOn(Organization, 'getLocale').mockResolvedValue('MX');
  db.query.mockImplementation(respond);
  db.execute.mockImplementation(respond);
  db.getConnection.mockImplementation(async () => conn());
});

afterEach(() => jest.restoreAllMocks());

const as = (orgId) => ({ Authorization: `Bearer ${token(orgId)}` });
const childWrites = (tables) => writes.filter((w) => tables.includes(w.table));

// [label, method, path, permission, body, child tables that must not be written]
const ROUTES = [
  ['client contacts read', 'get', '/api/v1/clients/3/contacts', 'clients.view', null, []],
  ['client contacts write', 'post', '/api/v1/clients/3/contacts', 'clients.update', { name: 'Bob Ray' }, ['contacts']],
  ['credit-note items read', 'get', '/api/v1/credit-notes/11/items', 'credit_notes.view', null, []],
  ['credit-note items write', 'post', '/api/v1/credit-notes/11/items', 'credit_notes.update',
    { description: 'Line', quantity: 2, unit_price: 25, amount: 50 }, ['credit_note_items']],
  ['payment allocations read', 'get', '/api/v1/payments/14/allocations', 'payments.view', null, []],
  ['invoice items read', 'get', '/api/v1/invoices/10/items', 'invoices.view', null, []],
  ['invoice payments read', 'get', '/api/v1/invoices/10/payments', 'payments.view', null, []],
  ['CFDI conceptos read', 'get', '/api/v1/cfdi-documents/13/conceptos', 'cfdi_documents.view', null, []],
  ['CFDI related read', 'get', '/api/v1/cfdi-documents/13/related', 'cfdi_documents.view', null, []],
  ['quote items read', 'get', '/api/v1/quotes/12/items', 'quotes.view', null, []],
  ['factura pública items read', 'get', '/api/v1/facturas-publicas/20/items', 'facturas_publicas.view', null, []],
  ['factura pública items write', 'post', '/api/v1/facturas-publicas/20/items', 'facturas_publicas.update',
    { invoice_id: 10 }, ['factura_publica_invoice_items']],
  ['inventory stock read', 'get', '/api/v1/inventory/items/30/stock', 'inventory.view', null, []],
  ['certificates by client', 'get', '/api/v1/subscriber-certificates/client/3', 'subscriber_certificates.view', null, []],
  ['certificates by RADIUS account', 'get', '/api/v1/subscriber-certificates/radius-account/40', 'subscriber_certificates.view', null, []],
  ['certificate revoke', 'post', '/api/v1/subscriber-certificates/50/revoke', 'subscriber_certificates.revoke',
    { revocation_reason: 'lost' }, ['subscriber_certificates']],
  ['device-group members read', 'get', '/api/v1/device-groups/60/members', 'device_groups.view', null, []],
  ['device-group members add', 'post', '/api/v1/device-groups/60/members', 'device_groups.update',
    { device_ids: [70] }, ['device_group_members']],
  ['device-group member remove', 'delete', '/api/v1/device-groups/60/members/70', 'device_groups.update', null, ['device_group_members']],
  ['CPE profile read', 'get', '/api/v1/cpe-profiles/80', 'cpe_profiles.view', null, []],
  ['CPE profile resolve', 'post', '/api/v1/cpe-profiles/80/resolve', 'cpe_profiles.view', {}, []],
];

function send(method, path, orgId, body) {
  const req = request(app)[method](path).set(as(orgId));
  return body ? req.send(body) : req;
}

describe.each(ROUTES)('%s (%s %s)', (_label, method, path, slug, body, tables) => {
  test(`another organization gets 404 and nothing is written, even with ${slug}`, async () => {
    granted = [slug];
    const res = await send(method, path, OTHER_ORG, body);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/psk-secret|Ann|Refund|Internet|Setup|alice/);
    expect(childWrites(tables)).toEqual([]);
  });

  test(`the owning organization with ${slug} succeeds`, async () => {
    granted = [slug];
    const res = await send(method, path, OWNER_ORG, body);
    expect([200, 201, 204]).toContain(res.status);
    if (tables.length) expect(childWrites(tables).length).toBeGreaterThan(0);
  });
});

describe('child reads return the owning organization\'s rows', () => {
  test.each([
    ['/api/v1/clients/3/contacts', 'clients.view', 300],
    ['/api/v1/credit-notes/11/items', 'credit_notes.view', 310],
    ['/api/v1/payments/14/allocations', 'payments.view', 320],
    ['/api/v1/invoices/10/items', 'invoices.view', 330],
    ['/api/v1/cfdi-documents/13/conceptos', 'cfdi_documents.view', 340],
    ['/api/v1/quotes/12/items', 'quotes.view', 350],
    ['/api/v1/facturas-publicas/20/items', 'facturas_publicas.view', 360],
    ['/api/v1/inventory/items/30/stock', 'inventory.view', 370],
  ])('%s', async (path, slug, childId) => {
    granted = [slug];
    const res = await send('get', path, OWNER_ORG);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => r.id)).toEqual([childId]);
  });
});

describe('credit-note items POST', () => {
  test('a body credit_note_id never chooses the parent — the URL id does', async () => {
    granted = ['credit_notes.update'];
    const res = await send('post', '/api/v1/credit-notes/11/items', OWNER_ORG,
      { description: 'Line', quantity: 2, unit_price: 25, amount: 50, credit_note_id: 16 });
    expect(res.status).toBe(201);
    const [insert] = childWrites(['credit_note_items']);
    expect(insert.params).toContain(11);
    expect(insert.params).not.toContain(16);
    expect(insert.params).toContain(OWNER_ORG);
  });

  test('a non-draft credit note rejects new lines with 422', async () => {
    granted = ['credit_notes.update'];
    FIX.credit_notes[0].status = 'issued';
    const res = await send('post', '/api/v1/credit-notes/11/items', OWNER_ORG,
      { description: 'Line', quantity: 2, unit_price: 25, amount: 50 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CREDIT_NOTE_NOT_DRAFT');
    expect(childWrites(['credit_note_items'])).toEqual([]);
  });

  test('a credit note with a live CFDI rejects new lines with 422', async () => {
    granted = ['credit_notes.update'];
    liveCfdi = true;
    const res = await send('post', '/api/v1/credit-notes/11/items', OWNER_ORG,
      { description: 'Line', quantity: 2, unit_price: 25, amount: 50 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CFDI_STAMPED');
    expect(childWrites(['credit_note_items'])).toEqual([]);
  });
});

describe('factura pública items POST', () => {
  test('another organization\'s invoice cannot be linked (422, nothing written)', async () => {
    granted = ['facturas_publicas.update'];
    const res = await send('post', '/api/v1/facturas-publicas/20/items', OWNER_ORG, { invoice_id: 15 });
    expect(res.status).toBe(422);
    expect(childWrites(['factura_publica_invoice_items'])).toEqual([]);
  });

  test('a stamped factura pública is frozen (422, nothing written)', async () => {
    granted = ['facturas_publicas.update'];
    FIX.factura_publica_invoices[0].status = 'stamped';
    const res = await send('post', '/api/v1/facturas-publicas/20/items', OWNER_ORG, { invoice_id: 10 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FACTURA_PUBLICA_NOT_DRAFT');
    expect(childWrites(['factura_publica_invoice_items'])).toEqual([]);
  });
});

describe('device-group members POST', () => {
  test('another organization\'s device cannot be added to an owned group (422, nothing written)', async () => {
    granted = ['device_groups.update'];
    const res = await send('post', '/api/v1/device-groups/60/members', OWNER_ORG, { device_ids: [70, 71] });
    expect(res.status).toBe(422);
    expect(childWrites(['device_group_members'])).toEqual([]);
  });
});

describe('CPE profiles', () => {
  test('a global (NULL-org) profile stays readable by every organization', async () => {
    granted = ['cpe_profiles.view'];
    const res = await send('get', '/api/v1/cpe-profiles/81', OTHER_ORG);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(81);
  });
});

describe('line-item POSTs: a body parent id never overrides the org-verified URL id', () => {
  test('POST /invoices/:id/items inserts into the URL invoice, not a body invoice_id', async () => {
    granted = ['invoices.update'];
    const addItem = jest.spyOn(Invoice, 'addItem').mockResolvedValue({ id: 901 });
    jest.spyOn(billingService, 'applyLineItemToTotals').mockResolvedValue(0);
    jest.spyOn(billingService, 'refreshInvoicePaidStatus').mockResolvedValue(undefined);
    const res = await send('post', '/api/v1/invoices/10/items', OWNER_ORG,
      { description: 'Fee', quantity: 2, unit_price: 25, amount: 50, invoice_id: 15 });
    expect(res.status).toBe(201);
    expect(addItem).toHaveBeenCalledTimes(1);
    expect(String(addItem.mock.calls[0][0].invoice_id)).toBe('10');
  });

  test('POST /quotes/:id/items inserts into the URL quote, not a body quote_id', async () => {
    granted = ['quotes.update'];
    const addItem = jest.spyOn(Quote, 'addItem').mockResolvedValue({ id: 902, total: '50.00' });
    jest.spyOn(billingService, 'applyQuoteLineItemToTotals').mockResolvedValue(0);
    const res = await send('post', '/api/v1/quotes/12/items', OWNER_ORG,
      { description: 'Fee', quantity: 2, unit_price: 25, amount: 50, quote_id: 99 });
    expect(res.status).toBe(201);
    expect(String(addItem.mock.calls[0][0].quote_id)).toBe('12');
  });
});

describe('GraphQL child resolvers bind ctx.orgId', () => {
  test('Client.contacts of a foreign client id resolves to nothing', async () => {
    const rows = await resolvers.Client.contacts({ id: 3 }, {}, { orgId: OTHER_ORG });
    expect(rows).toEqual([]);
    const owned = await resolvers.Client.contacts({ id: 3 }, {}, { orgId: OWNER_ORG });
    expect(owned.map((r) => r.id)).toEqual([300]);
  });

  test('Invoice.items and Invoice.appliedPayments bind the org', async () => {
    expect(await resolvers.Invoice.items({ id: 10 }, {}, { orgId: OTHER_ORG })).toEqual([]);
    expect(await resolvers.Invoice.appliedPayments({ id: 10 }, {}, { orgId: OTHER_ORG })).toEqual([]);
  });
});

describe('scoped child helpers refuse a missing orgId', () => {
  test('Client.getContacts(id) without an org throws instead of running unscoped', async () => {
    await expect(Client.getContacts(3)).rejects.toThrow(/requires an orgId/);
    expect(db.query).not.toHaveBeenCalled();
  });
});
