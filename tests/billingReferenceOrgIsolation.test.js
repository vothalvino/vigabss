// =============================================================================
// VigaBSS 5.0 — Billing references must stay inside the caller's organization
// =============================================================================
// Phase 1 audit items BIL-04, TNB-09, TNA-12 and BIL-10. Each drives the real
// router, auth and RBAC middleware against an in-memory database fake that
// evaluates simple `col = ?` / `col <=> ?` / `col = 'literal'` predicates the
// way MySQL would — so a statement that forgets its organization_id (or
// client_id) predicate finds another tenant's row here exactly as it did live.
//
//   BIL-04  invoices/quotes accepted an unverified contract_id; paying the
//           invoice then reconnected that (foreign) suspended contract.
//   TNB-09  POST/PUT/PATCH /payments accepted another tenant's client_id.
//   TNA-12  POST /bulk/invoices/generate inserted billing periods on any
//           tenant's contracts and counted no-ops as success.
//   BIL-10  PUT /cfdi-documents/:id re-pointed filed CFDIs.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

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
const billingService = require('../src/services/billingService');
const app = require('../src/app');

const OWN = 1001;
const OTHER = 2002;

const token = (orgId) => jwt.sign(
  { sub: 50, email: 'billing@isp.example', role: 'billing', orgId },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);

function freshFixtures() {
  return {
    clients: [
      { id: 3, organization_id: OWN, name: 'Alice', tax_exempt: 1, deleted_at: null },
      { id: 4, organization_id: OWN, name: 'Bob', tax_exempt: 1, deleted_at: null },
      { id: 9, organization_id: OTHER, name: 'Mallory', tax_exempt: 1, deleted_at: null },
    ],
    contracts: [
      // Own contract of client 3.
      { id: 7, organization_id: OWN, client_id: 3, status: 'active', plan_id: 1, plan_name: 'Home', plan_price: '100.00', plan_currency: 'MXN', start_date: '2026-01-01', billing_day: 1, deleted_at: null },
      // Own contract, but of client 4.
      { id: 8, organization_id: OWN, client_id: 4, status: 'active', plan_id: 1, plan_name: 'Home', plan_price: '100.00', plan_currency: 'MXN', start_date: '2026-01-01', billing_day: 1, deleted_at: null },
      // Another tenant's suspended contract.
      { id: 70, organization_id: OTHER, client_id: 9, status: 'suspended', plan_id: 1, plan_name: 'Biz', plan_price: '500.00', plan_currency: 'MXN', start_date: '2026-01-01', billing_day: 1, deleted_at: null },
    ],
    invoices: [
      { id: 10, organization_id: OWN, client_id: 3, contract_id: null, invoice_number: 'F-10', status: 'draft', subtotal: '100.00', tax_amount: '0.00', total: '100.00', tax_rate: '0.0000', currency: 'MXN', deleted_at: null },
    ],
    quotes: [
      { id: 12, organization_id: OWN, client_id: 3, contract_id: 7, status: 'draft', deleted_at: null },
    ],
    payments: [
      { id: 14, organization_id: OWN, client_id: 3, amount: '5.00', currency: 'MXN', status: 'completed', deleted_at: null },
    ],
    cfdi_documents: [
      { id: 13, organization_id: OWN, client_id: 3, invoice_id: 10, sat_status: 'vigente', serie: 'A' },
      { id: 17, organization_id: OWN, client_id: 3, invoice_id: 10, sat_status: 'draft', serie: 'A' },
    ],
  };
}

let FIX;
let granted;
let writes;

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

// Evaluate the WHERE clause's simple predicates. Placeholders are consumed in
// order, so every `?` before WHERE (none in the statements exercised here)
// would have to be skipped — asserted below.
function matches(sql, params, row) {
  const where = sql.split(/\bWHERE\b/i)[1];
  if (!where) return true;
  const before = sql.split(/\bWHERE\b/i)[0];
  let p = (before.match(/\?/g) || []).length;
  const re = /(?:\w+\.)?(\w+)\s*(<=>|=)\s*(\?|'[^']*')|(?:\w+\.)?(\w+)\s+IS\s+(NOT\s+)?NULL/gi;
  let m;
  while ((m = re.exec(where))) {
    if (m[4]) {
      const isNull = row[m[4]] === null || row[m[4]] === undefined;
      if (m[5] ? isNull : !isNull) return false;
      continue;
    }
    const [, col, , rhs] = m;
    const value = rhs === '?' ? params[p++] : rhs.slice(1, -1);
    if (!(col in row)) continue; // a column the fixture does not model
    if (String(row[col]) !== String(value)) return false;
  }
  return true;
}

async function respond(sql, params = []) {
  if (/FROM `?users`?\b/.test(sql)) {
    return [[{ id: 50, email: 'billing@isp.example', role: 'billing', status: 'active', organization_id: OWN }]];
  }
  const { table, write } = tableOf(sql);
  if (write) {
    writes.push({ table, sql, params });
    // Make a fresh INSERT readable by the route's read-back.
    if (/^\s*INSERT/i.test(sql) && FIX[table]) FIX[table].push({ id: 900, organization_id: OWN, deleted_at: null });
    return [{ insertId: 900, affectedRows: 1 }];
  }
  if (/COUNT\(\*\)/i.test(sql)) return [[{ total: 0, cnt: 0 }]];
  if (!table || !FIX[table]) return [[]];
  return [FIX[table].filter((r) => matches(sql, params, r))];
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
  config.features.cfdi = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  FIX = freshFixtures();
  granted = [];
  writes = [];
  jest.spyOn(User, 'getPermissions').mockImplementation(async () => granted);
  jest.spyOn(Organization, 'getLocale').mockResolvedValue('MX');
  jest.spyOn(Organization, 'getCurrency').mockResolvedValue('MXN');
  db.query.mockImplementation(respond);
  db.execute.mockImplementation(respond);
  db.getConnection.mockImplementation(async () => conn());
});

afterEach(() => jest.restoreAllMocks());

const send = (method, path, body) => {
  const req = request(app)[method](path).set({ Authorization: `Bearer ${token(OWN)}` });
  return body ? req.send(body) : req;
};
const writesTo = (table) => writes.filter((w) => w.table === table);

describe('fixture sanity', () => {
  test('the predicate evaluator binds org and client like MySQL', () => {
    const sql = 'SELECT id FROM contracts WHERE id = ? AND organization_id = ? AND client_id = ? AND deleted_at IS NULL';
    expect(FIX.contracts.filter((r) => matches(sql, [7, OWN, 3], r))).toHaveLength(1);
    expect(FIX.contracts.filter((r) => matches(sql, [70, OWN, 3], r))).toHaveLength(0);
    expect(FIX.contracts.filter((r) => matches(sql, [8, OWN, 3], r))).toHaveLength(0);
    // Unscoped, the foreign contract IS found — which is what the old code did.
    expect(FIX.contracts.filter((r) => matches('SELECT * FROM contracts WHERE id = ?', [70], r))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// BIL-04 — invoice / quote contract_id
// ---------------------------------------------------------------------------
describe('BIL-04: POST /invoices verifies contract_id', () => {
  const body = (contractId) => ({
    client_id: 3, contract_id: contractId, invoice_number: 'F-99', subtotal: 100, total: 100, due_date: '2026-12-01',
  });

  // Tax coherence is covered elsewhere; keep it out of the way here.
  beforeEach(() => jest.spyOn(billingService, 'assertTaxCoherent').mockResolvedValue(undefined));

  test.each([
    ['another tenant\'s suspended contract', 70],
    ['an own contract of a different client', 8],
    ['a contract that does not exist', 4040],
  ])('%s is rejected with 422 and no invoice is written', async (_label, contractId) => {
    granted = ['invoices.create'];
    const res = await send('post', '/api/v1/invoices', body(contractId));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).toMatch(/contract_id/);
    expect(writesTo('invoices')).toEqual([]);
  });

  test('the client\'s own contract is accepted', async () => {
    granted = ['invoices.create'];
    const res = await send('post', '/api/v1/invoices', body(7));
    expect(res.status).toBe(201);
    const [insert] = writesTo('invoices');
    expect(insert.params.slice(0, 3)).toEqual([OWN, 3, 7]);
  });
});

describe('BIL-04: PUT/PATCH /invoices/:id verifies contract_id', () => {
  test.each(['put', 'patch'])('%s with another tenant\'s contract is rejected and nothing is updated', async (method) => {
    granted = ['invoices.update'];
    const res = await send(method, '/api/v1/invoices/10', { contract_id: 70 });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/contract_id/);
    expect(writesTo('invoices')).toEqual([]);
  });

  test('moving the invoice to another client re-checks the stored contract', async () => {
    granted = ['invoices.update'];
    FIX.invoices[0].contract_id = 7; // client 3's contract
    const res = await send('patch', '/api/v1/invoices/10', { client_id: 4 });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/contract_id/);
    expect(writesTo('invoices')).toEqual([]);
  });

  test('the client\'s own contract is accepted', async () => {
    granted = ['invoices.update'];
    const res = await send('patch', '/api/v1/invoices/10', { contract_id: 7 });
    expect(res.status).toBe(200);
    expect(writesTo('invoices')).toHaveLength(1);
  });
});

describe('BIL-04: quotes bind the contract to the quote\'s client', () => {
  test('POST /quotes with an own contract of another client is rejected', async () => {
    granted = ['quotes.create'];
    const res = await send('post', '/api/v1/quotes', { client_id: 3, contract_id: 8, quote_number: 'Q-1' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/contract_id/);
    expect(writesTo('quotes')).toEqual([]);
  });

  test('PUT /quotes/:id moving the client away from the stored contract is rejected', async () => {
    granted = ['quotes.update'];
    const res = await send('put', '/api/v1/quotes/12', { client_id: 4 });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/contract_id/);
    expect(writesTo('quotes')).toEqual([]);
  });

  test('POST /quotes with the client\'s own contract is accepted', async () => {
    granted = ['quotes.create'];
    const res = await send('post', '/api/v1/quotes', { client_id: 3, contract_id: 7, quote_number: 'Q-2' });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// TNB-09 — payments client_id
// ---------------------------------------------------------------------------
describe('TNB-09: payments client_id stays in the caller org', () => {
  test('POST /payments with another tenant\'s client is rejected and nothing is written', async () => {
    granted = ['payments.create'];
    const res = await send('post', '/api/v1/payments', { client_id: 9, amount: 50 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CLIENT_NOT_FOUND');
    expect(writesTo('payments')).toEqual([]);
    expect(writesTo('client_balance_ledger')).toEqual([]);
  });

  test('POST /payments with an own client is accepted', async () => {
    granted = ['payments.create'];
    const res = await send('post', '/api/v1/payments', { client_id: 3, amount: 50 });
    expect(res.status).toBe(201);
    expect(writesTo('payments')).toHaveLength(1);
  });

  test.each(['put', 'patch'])('%s /payments/:id cannot re-point the client (422, nothing updated)', async (method) => {
    granted = ['payments.update'];
    const res = await send(method, '/api/v1/payments/14', { client_id: 9, notes: 'moved' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_CLIENT_IMMUTABLE');
    expect(writesTo('payments')).toEqual([]);
  });

  test('an update that repeats the same client_id still succeeds and never writes client_id', async () => {
    granted = ['payments.update'];
    const res = await send('patch', '/api/v1/payments/14', { client_id: 3, reference_number: 'R-1' });
    expect(res.status).toBe(200);
    const [update] = writesTo('payments');
    expect(update.sql).not.toMatch(/client_id/);
  });
});

// ---------------------------------------------------------------------------
// TNA-12 — bulk invoice generation
// ---------------------------------------------------------------------------
describe('TNA-12: POST /bulk/invoices/generate', () => {
  test('another tenant\'s contract is skipped, nothing is written, and it is not a success', async () => {
    granted = ['invoices.create'];
    const period = jest.spyOn(billingService, 'generateBillingPeriod');
    const res = await send('post', '/api/v1/bulk/invoices/generate', { contract_ids: [70] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ success: 0, skipped: 1, failed: 0 });
    expect(res.body.data.errors[0]).toMatchObject({ contract_id: 70, code: 'CONTRACT_NOT_FOUND' });
    expect(period).not.toHaveBeenCalled();
    expect(writesTo('billing_periods')).toEqual([]);
  });

  test('a contract with nothing due is reported as skipped, not success', async () => {
    granted = ['invoices.create'];
    jest.spyOn(billingService, 'generateBillingPeriod').mockResolvedValue({
      id: 5, status: 'pending', scheduled_at: new Date(Date.now() + 86400000 * 10),
    });
    const invoice = jest.spyOn(billingService, 'generateInvoice');
    const res = await send('post', '/api/v1/bulk/invoices/generate', { contract_ids: [7] });
    expect(res.body.data).toMatchObject({ success: 0, skipped: 1 });
    expect(res.body.data.errors[0].code).toBe('PERIOD_NOT_DUE');
    expect(invoice).not.toHaveBeenCalled();
  });

  test('an own active contract with a due period produces a real invoice', async () => {
    granted = ['invoices.create'];
    jest.spyOn(billingService, 'generateBillingPeriod').mockResolvedValue({
      id: 5, status: 'pending', scheduled_at: new Date(Date.now() - 1000),
    });
    const invoice = jest.spyOn(billingService, 'generateInvoice').mockResolvedValue({ id: 321 });
    const res = await send('post', '/api/v1/bulk/invoices/generate', { contract_ids: [7] });
    expect(res.body.data).toMatchObject({ success: 1, skipped: 0, invoice_ids: [321] });
    expect(invoice).toHaveBeenCalledWith(
      expect.objectContaining({ id: 5 }), expect.objectContaining({ id: 7 }),
      expect.objectContaining({ name: 'Home' }), OWN,
    );
  });
});

// ---------------------------------------------------------------------------
// BIL-10 — CFDI document edits
// ---------------------------------------------------------------------------
describe('BIL-10: PUT /cfdi-documents/:id', () => {
  test('a filed (vigente) CFDI cannot be edited at all', async () => {
    granted = ['cfdi_documents.update'];
    const res = await send('put', '/api/v1/cfdi-documents/13', { invoice_id: 99, serie: 'B' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CFDI_NOT_DRAFT');
    expect(writesTo('cfdi_documents')).toEqual([]);
  });

  test('a draft edit never carries the link ids or amounts through', async () => {
    granted = ['cfdi_documents.update'];
    const res = await send('put', '/api/v1/cfdi-documents/17', {
      serie: 'B', invoice_id: 99, client_id: 9, payment_id: 1, credit_note_id: 1, total: 1,
    });
    expect(res.status).toBe(200);
    const [update] = writesTo('cfdi_documents');
    expect(update.sql).toMatch(/serie/);
    expect(update.sql).not.toMatch(/invoice_id|client_id|payment_id|credit_note_id|`total`/);
  });
});
