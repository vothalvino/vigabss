// =============================================================================
// VigaBSS — Quote -> invoice cross-tenant isolation (audit finding TNB-05)
// =============================================================================
// A billing user in org A could create (or re-point) a quote at org B's
// client/contract, mint it straight into status 'accepted', and convert it to
// an issued org-A invoice — which org B's subscriber portal then listed and
// offered to pay through org A's gateway. These tests drive the REAL routers
// (staff /quotes and subscriber /portal/invoices) through supertest with the
// database replaced by a tiny in-memory table fake that honestly applies the
// `col = ?` / `col <=> ?` predicates the route actually wrote — so a query
// that forgets its organization predicate really does return the other
// tenant's row, exactly as MySQL would.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

jest.mock('../src/services/orgPrincipalService', () => ({
  resolveOrgPrincipal: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const billingService = require('../src/services/billingService');
const checkoutService = require('../src/services/checkoutService');
const pdfService = require('../src/services/pdfService');
const { resolveOrgPrincipal } = require('../src/services/orgPrincipalService');
const { signPortalAccessToken } = require('../src/utils/accessTokens');
const app = require('../src/app');

const ORG_A = 10;
const ORG_B = 20;
const BILLING_USER = { id: 5, email: 'billing@a.test', role: 'billing', status: 'active', organization_id: ORG_A };

// ---------------------------------------------------------------------------
// In-memory table fake
// ---------------------------------------------------------------------------
let tables;
let writes;

function seed() {
  tables = {
    users: [BILLING_USER],
    clients: [
      { id: 1001, organization_id: ORG_A, name: 'Own Client', email: 'own@a.test', status: 'active' },
      { id: 2002, organization_id: ORG_B, name: 'Victim', email: 'victim@b.test', status: 'active' },
      { id: 3003, organization_id: null, name: 'Single-tenant', email: 'st@x.test', status: 'active' },
    ],
    contracts: [
      { id: 501, organization_id: ORG_A, client_id: 1001 },
      { id: 902, organization_id: ORG_B, client_id: 2002 },
    ],
    quotes: [
      { id: 70, organization_id: ORG_A, client_id: 1001, contract_id: null, status: 'draft', quote_number: 'Q-70' },
      // A pre-fix quote already pointing at org B's client, approved.
      {
        id: 71, organization_id: ORG_A, client_id: 2002, contract_id: null, status: 'accepted',
        quote_number: 'Q-71', converted_invoice_id: null, subtotal: '100.00', tax_amount: '16.00',
        total: '116.00', currency: 'MXN', tax_rate: '0.1600', tax_rate_id: null, notes: null,
      },
    ],
    invoices: [
      // Issued by org A against org B's client_id (the TNB-05 artifact).
      { id: 800, organization_id: ORG_A, client_id: 2002, invoice_number: 'A-800', total: '116.00', status: 'issued' },
      // Org B's own legitimate invoice for the same subscriber.
      { id: 801, organization_id: ORG_B, client_id: 2002, invoice_number: 'B-801', total: '50.00', status: 'issued' },
      // Single-tenant install: NULL org on both client and invoice.
      { id: 802, organization_id: null, client_id: 3003, invoice_number: 'ST-802', total: '10.00', status: 'issued' },
    ],
  };
  writes = [];
}

const sqlEq = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
const nullSafeEq = (a, b) => ((a === null || a === undefined) && (b === null || b === undefined)) || sqlEq(a, b);

function fakeSql(sql, params = []) {
  if (typeof sql !== 'string') return Promise.resolve([[]]);
  const text = sql.replace(/\s+/g, ' ').trim();

  const insert = text.match(/^INSERT INTO `?(\w+)`? \(([^)]*)\) VALUES/i);
  if (insert) {
    const [, table, colList] = insert;
    writes.push({ op: 'insert', table, sql: text, params });
    const cols = colList.split(',').map(c => c.trim().replace(/`/g, ''));
    const row = { id: 9000 + writes.length };
    cols.forEach((c, i) => { row[c] = params[i]; });
    if (tables[table]) tables[table].push(row);
    return Promise.resolve([{ insertId: row.id, affectedRows: 1 }]);
  }
  if (/^UPDATE /i.test(text)) {
    const table = text.match(/^UPDATE `?(\w+)`?/i)[1];
    writes.push({ op: 'update', table, sql: text, params });
    return Promise.resolve([{ affectedRows: 1 }]);
  }

  const from = text.match(/ FROM `?(\w+)`?/i);
  const table = from && from[1];
  if (!table || !tables[table]) return Promise.resolve([[]]);

  // Apply every `col = ?` / `col <=> ?` predicate of the OUTERMOST WHERE
  // (the last one — list/detail queries carry a subquery WHERE first).
  const whereAt = text.lastIndexOf(' WHERE ');
  const before = whereAt === -1 ? '' : text.slice(0, whereAt);
  let p = (before.match(/\?/g) || []).length;
  const where = whereAt === -1 ? '' : text.slice(whereAt);
  const preds = [...where.matchAll(/(?:\w+\.)?`?(\w+)`?\s*(<=>|=)\s*\?/g)];
  const rows = tables[table].filter(row => preds.every(([, col, op], i) => {
    const value = params[p + i];
    return op === '<=>' ? nullSafeEq(row[col], value) : sqlEq(row[col], value);
  }));
  p += preds.length;

  if (/SELECT COUNT\(\*\) AS total/i.test(text)) return Promise.resolve([[{ total: rows.length }]]);
  return Promise.resolve([rows.map(r => ({ ...r }))]);
}

function buildConn() {
  return {
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    release: jest.fn(),
    execute: jest.fn(fakeSql),
    query: jest.fn(fakeSql),
  };
}

function staffToken() {
  return jwt.sign({ sub: BILLING_USER.id, email: BILLING_USER.email, orgId: ORG_A }, config.jwt.secret, { expiresIn: '1h' });
}
function portalToken(clientId, orgId) {
  return signPortalAccessToken({ clientId, organizationId: orgId }, 3600);
}

const quoteWrites = () => writes.filter(w => w.table === 'quotes');
const invoiceWrites = () => writes.filter(w => w.table === 'invoices');

let conn;
beforeEach(() => {
  jest.clearAllMocks();
  seed();
  conn = buildConn();
  db.query.mockImplementation(fakeSql);
  db.execute.mockImplementation(fakeSql);
  db.getConnection.mockResolvedValue(conn);
  // Real billing persona: a non-admin principal whose permission set is
  // resolved through User.getPermissions (no legacy-admin shortcut).
  resolveOrgPrincipal.mockResolvedValue({
    organizationId: ORG_A,
    authorizationRole: 'billing',
    membershipRole: 'billing',
    isInstallOperator: false,
    isSuperAdmin: false,
    hasGlobalOrganizationAccess: false,
  });
  jest.spyOn(User, 'getPermissions').mockResolvedValue([
    'quotes.view', 'quotes.create', 'quotes.update', 'invoices.create',
  ]);
  jest.spyOn(billingService, 'nextQuoteNumber').mockResolvedValue('Q-0001');
});

afterEach(() => { jest.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// Staff quote writes
// ---------------------------------------------------------------------------
describe('POST /api/v1/quotes — client/contract must belong to the caller org', () => {
  it('rejects another org\'s client_id with 422 (auto-numbered branch) and writes nothing', async () => {
    const res = await request(app)
      .post('/api/v1/quotes')
      .set('Authorization', `Bearer ${staffToken()}`)
      .send({ client_id: 2002, total: 116, status: 'accepted' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(quoteWrites()).toHaveLength(0);
    expect(billingService.nextQuoteNumber).not.toHaveBeenCalled();
  });

  it('rejects another org\'s client_id with 422 (explicit quote_number branch) and writes nothing', async () => {
    const res = await request(app)
      .post('/api/v1/quotes')
      .set('Authorization', `Bearer ${staffToken()}`)
      .send({ client_id: 2002, quote_number: 'X-1', total: 116 });

    expect(res.status).toBe(422);
    expect(quoteWrites()).toHaveLength(0);
  });

  it('rejects an own client paired with another org\'s contract_id with 422', async () => {
    const res = await request(app)
      .post('/api/v1/quotes')
      .set('Authorization', `Bearer ${staffToken()}`)
      .send({ client_id: 1001, contract_id: 902, total: 10 });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/contract_id/);
    expect(quoteWrites()).toHaveLength(0);
  });

  it('creates a quote for an own client + contract but never persists a caller-supplied status', async () => {
    const res = await request(app)
      .post('/api/v1/quotes')
      .set('Authorization', `Bearer ${staffToken()}`)
      .send({ client_id: 1001, contract_id: 501, total: 10, status: 'accepted' });

    expect(res.status).toBe(201);
    const [insert] = quoteWrites();
    expect(insert.op).toBe('insert');
    expect(insert.sql).not.toMatch(/`status`/);
    expect(insert.params).not.toContain('accepted');
    expect(insert.params).toEqual(expect.arrayContaining([ORG_A, 1001, 501]));
  });
});

describe('PUT /api/v1/quotes/:id — no cross-org re-point, no status write', () => {
  it('rejects re-pointing an own quote at another org\'s client with 422 and does not UPDATE', async () => {
    const res = await request(app)
      .put('/api/v1/quotes/70')
      .set('Authorization', `Bearer ${staffToken()}`)
      .send({ client_id: 2002 });

    expect(res.status).toBe(422);
    expect(quoteWrites().filter(w => w.op === 'update')).toHaveLength(0);
  });

  it('rejects re-pointing at another org\'s contract with 422', async () => {
    const res = await request(app)
      .put('/api/v1/quotes/70')
      .set('Authorization', `Bearer ${staffToken()}`)
      .send({ contract_id: 902 });

    expect(res.status).toBe(422);
    expect(quoteWrites().filter(w => w.op === 'update')).toHaveLength(0);
  });

  it('drops status from an update body — only /approve and /reject change it', async () => {
    const res = await request(app)
      .put('/api/v1/quotes/70')
      .set('Authorization', `Bearer ${staffToken()}`)
      .send({ notes: 'edited', status: 'accepted' });

    expect(res.status).toBe(200);
    const updates = quoteWrites().filter(w => w.op === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toMatch(/`notes` = \?/);
    expect(updates[0].sql).not.toMatch(/`status`/);
    expect(updates[0].params).not.toContain('accepted');
  });
});

describe('POST /api/v1/quotes/:id/convert-to-invoice — re-verifies the quote\'s client', () => {
  it('refuses (422) to issue an invoice from an accepted quote carrying another org\'s client', async () => {
    const res = await request(app)
      .post('/api/v1/quotes/71/convert-to-invoice')
      .set('Authorization', `Bearer ${staffToken()}`)
      .send({});

    expect(res.status).toBe(422);
    expect(invoiceWrites()).toHaveLength(0);
    expect(db.getConnection).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Subscriber portal invoice reads/actions
// ---------------------------------------------------------------------------
describe('portal /invoices — scoped to the subscriber\'s own organization', () => {
  const victim = () => `Bearer ${portalToken(2002, ORG_B)}`;

  it('GET /portal/invoices lists only the subscriber org\'s invoices (and counts consistently)', async () => {
    const res = await request(app).get('/api/v1/portal/invoices').set('Authorization', victim());

    expect(res.status).toBe(200);
    expect(res.body.data.map(i => i.id)).toEqual([801]);
    expect(res.body.meta.total).toBe(1);
  });

  it('GET /portal/invoices/:id 404s for a foreign-org invoice carrying the subscriber\'s client_id', async () => {
    const res = await request(app).get('/api/v1/portal/invoices/800').set('Authorization', victim());
    expect(res.status).toBe(404);

    const own = await request(app).get('/api/v1/portal/invoices/801').set('Authorization', victim());
    expect(own.status).toBe(200);
    expect(own.body.data.id).toBe(801);
  });

  it('POST /portal/invoices/:id/pay 404s for a foreign-org invoice and never opens a checkout', async () => {
    const spy = jest.spyOn(checkoutService, 'createCheckoutSession').mockResolvedValue({ url: 'https://pay.example' });
    const res = await request(app).post('/api/v1/portal/invoices/800/pay').set('Authorization', victim()).send({});

    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('GET /portal/invoices/:id/pdf 404s for a foreign-org invoice and never renders it', async () => {
    const spy = jest.spyOn(pdfService, 'generateInvoicePdf').mockResolvedValue(Buffer.from('%PDF'));
    const res = await request(app).get('/api/v1/portal/invoices/800/pdf').set('Authorization', victim());

    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('GET /portal/invoices/:id/cfdi 404s for a foreign-org invoice before any CFDI lookup', async () => {
    const res = await request(app).get('/api/v1/portal/invoices/800/cfdi').set('Authorization', victim());

    expect(res.status).toBe(404);
    expect(db.query.mock.calls.some(([sql]) => /FROM cfdi_documents/.test(sql))).toBe(false);
  });

  it('GET /portal/invoices/:id/cfdi never serves another org\'s CFDI that names this invoice id (BIL-10)', async () => {
    tables.cfdi_documents = [
      // A re-pointed org-A CFDI naming org B's invoice 801.
      { id: 60, organization_id: ORG_A, invoice_id: 801, sat_status: 'vigente', uuid: 'U-A', signed_xml: '<a-foreign/>' },
    ];
    const foreign = await request(app).get('/api/v1/portal/invoices/801/cfdi').set('Authorization', victim());
    expect(foreign.status).toBe(404);
    expect(foreign.text).not.toMatch(/a-foreign/);

    tables.cfdi_documents.push(
      { id: 61, organization_id: ORG_B, invoice_id: 801, sat_status: 'vigente', uuid: 'U-B', signed_xml: '<b-own/>' },
    );
    const own = await request(app).get('/api/v1/portal/invoices/801/cfdi').set('Authorization', victim());
    expect(own.status).toBe(200);
    expect(own.text).toBe('<b-own/>');
  });

  it('still serves a single-tenant install where client and invoice organization_id are NULL', async () => {
    const res = await request(app)
      .get('/api/v1/portal/invoices')
      .set('Authorization', `Bearer ${portalToken(3003, null)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map(i => i.id)).toEqual([802]);
  });
});
