// =============================================================================
// DAL-05 — deleting an invoice strands its allocations; selectors read deleted rows
// =============================================================================
// DELETE /invoices/:id only checked for a live CFDI, so a paid invoice could be
// archived with its payment_allocations still live. computeClientBalance then
// dropped the invoice but still netted the allocations out of the payments, and
// the money counted neither as debt nor as credit. voidInvoiceById already
// refuses that case; delete now does too.
//
// Several selectors also acted on archived invoices: staff checkout and payment
// links, the dashboard summary, revenue, MRR and overdue lists, reseller
// revenue and the reseller-portal invoice list.
// =============================================================================

const request = require('supertest');

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 8, role: 'admin' }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = 5; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const { mockTxConnection, txSql } = require('./fixtures/mockTxConnection');
const app = require('../src/app');

const STORED = { id: 900, organization_id: 5, client_id: 42, status: 'paid', total: '1160.00', currency: 'MXN' };

function wireDb({ allocated }) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM cfdi_documents/.test(sql)) return [[]];
    if (/FROM payment_allocations/.test(sql)) return [allocated ? [{ id: 1 }] : []];
    if (/SELECT \* FROM `?invoices`? WHERE id/.test(sql)) return [[STORED]];
    if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
}

let conn;
beforeEach(() => {
  jest.clearAllMocks();
  conn = mockTxConnection(db);
});

describe('DELETE /api/v1/invoices/:id', () => {
  it('refuses while payments are allocated (422 INVOICE_HAS_PAYMENTS) and rolls back', async () => {
    wireDb({ allocated: true });
    const res = await request(app).delete('/api/v1/invoices/900');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVOICE_HAS_PAYMENTS');
    expect(txSql(conn).some((sql) => /^\s*UPDATE `?invoices`?/i.test(sql))).toBe(false);
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('checks the allocations on the open transaction, not the pool', async () => {
    wireDb({ allocated: true });
    await request(app).delete('/api/v1/invoices/900');
    expect(txSql(conn).some((sql) => /FROM payment_allocations/.test(sql))).toBe(true);
  });

  it('still deletes an invoice with no allocations', async () => {
    wireDb({ allocated: false });
    const res = await request(app).delete('/api/v1/invoices/900');
    expect(res.status).toBeLessThan(300);
  });
});

describe('selectors leave archived invoices out', () => {
  const sqlOf = (mockFn, re) => mockFn.mock.calls.map(([sql]) => sql).filter((sql) => re.test(sql));

  it('staff checkout and payment links', async () => {
    const checkoutService = require('../src/services/checkoutService');
    db.query.mockResolvedValue([[]]);
    await checkoutService.createCheckoutSession({ organizationId: 5, invoiceId: 900, clientId: 42 }).catch(() => {});
    await checkoutService.generatePaymentLink({ organizationId: 5, invoiceId: 900 }).catch(() => {});
    const reads = sqlOf(db.query, /FROM invoices/);
    expect(reads).toHaveLength(2);
    for (const sql of reads) expect(sql).toMatch(/deleted_at IS NULL/);
  });

  it('dashboard summary, revenue, MRR and overdue', async () => {
    const dash = require('../src/controllers/dashboardController');
    db.queryReplica.mockResolvedValue([[{}]]);
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const req = { orgId: 5, query: {} };
    for (const fn of [dash.summary, dash.revenue, dash.mrr, dash.overdue]) await fn(req, res, jest.fn());
    const invoiceReads = sqlOf(db.queryReplica, /FROM invoices/);
    expect(invoiceReads.length).toBeGreaterThanOrEqual(3);
    for (const sql of invoiceReads) expect(sql).toMatch(/deleted_at IS NULL/);
    const [mrrSql] = sqlOf(db.queryReplica, /AS mrr/);
    expect(mrrSql).toMatch(/c\.deleted_at IS NULL/);
  });

  it('reseller revenue', () => {
    const text = require('fs').readFileSync(require.resolve('../src/services/resellerService'), 'utf8');
    const start = text.indexOf('AS rev');
    const revenueSql = text.slice(start, text.indexOf("status = 'paid'", start));
    expect(revenueSql).toMatch(/deleted_at IS NULL/);
  });

  it('reseller-portal invoice list', () => {
    const text = require('fs').readFileSync(require.resolve('../src/routes/resellerPortal'), 'utf8');
    expect(text).toMatch(/inPlaceholders\(clientIds\)\}\)`, 'i\.deleted_at IS NULL'\]/);
  });
});
