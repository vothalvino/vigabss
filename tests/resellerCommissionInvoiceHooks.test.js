// =============================================================================
// Reseller program, phase 4: the invoice routes sync the reseller commission
// =============================================================================
// A hand edit (PUT/PATCH) can take a paid invoice back to issued or draft, an
// invoice paid by credit notes alone can be archived (DELETE) and restored.
// Each runs resellerCommissionService.syncResellerCommission on the row-locked
// transaction of the write (crudController transactionalAfterHooks), so a
// failure rolls the write back. The engine itself is covered by
// tests/resellerCommissions.test.js.
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
jest.mock('../src/services/billingService', () => ({
  invoiceTaxFraction: (r) => { const n = parseFloat(r) || 0; return n > 1 ? n / 100 : n; },
  refreshInvoicePaidStatus: jest.fn().mockResolvedValue(true),
  assertTaxCoherent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/resellerCommissionService', () => ({
  syncResellerCommission: jest.fn().mockResolvedValue({ action: 'none' }),
}));
jest.mock('../src/models/Organization', () => ({
  getCurrency: jest.fn().mockResolvedValue('MXN'),
  update: jest.fn(),
  findById: jest.fn(),
}));

const db = require('../src/config/database');
const billingService = require('../src/services/billingService');
const commissions = require('../src/services/resellerCommissionService');
const { mockTxConnection } = require('./fixtures/mockTxConnection');
const app = require('../src/app');

const PAID = {
  id: 900, organization_id: 5, client_id: 42, invoice_number: 'INV-000042', status: 'paid',
  subtotal: '1000.00', tax_amount: '160.00', total: '1160.00', tax_rate: '0.1600', currency: 'MXN',
  paid_at: '2026-11-07T10:00:00.000Z', deleted_at: null,
};

let conn;
function wireDb() {
  db.query.mockImplementation(async (sql) => {
    if (/FROM cfdi_documents/.test(sql)) return [[]];
    if (/SELECT id FROM payment_allocations/.test(sql)) return [[]];
    if (/SELECT credit_note_id FROM credit_note_applications/.test(sql)) return [[]];
    if (/SELECT \* FROM `?invoices`? WHERE id/.test(sql)) return [[{ ...PAID }]];
    if (/^UPDATE `?invoices`?/i.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  conn = mockTxConnection(db);
  wireDb();
});

const syncedOnTransaction = () => {
  expect(commissions.syncResellerCommission).toHaveBeenCalledTimes(1);
  const [exec, id, orgId, opts] = commissions.syncResellerCommission.mock.calls[0];
  expect(Number(id)).toBe(900);
  expect(orgId).toBe(5);
  // The executor is the write's transaction, and the sync ran before commit.
  return { exec, opts };
};

test('PATCH back to issued syncs (reverses) the commission inside the locked transaction', async () => {
  const res = await request(app).patch('/api/v1/invoices/900').send({ status: 'issued' });
  expect(res.status).toBe(200);
  const { exec } = syncedOnTransaction();
  await exec('SELECT 1', []);
  expect(conn.execute).toHaveBeenLastCalledWith('SELECT 1', []);
  expect(commissions.syncResellerCommission.mock.invocationCallOrder[0]).toBeLessThan(conn.commit.mock.invocationCallOrder[0]);
});

test('a failing sync rolls the edit back (fatal after-hook)', async () => {
  commissions.syncResellerCommission.mockRejectedValueOnce(new Error('ledger down'));
  const res = await request(app).patch('/api/v1/invoices/900').send({ status: 'issued' });
  expect(res.status).toBe(500);
  expect(conn.rollback).toHaveBeenCalled();
  expect(conn.commit).not.toHaveBeenCalled();
});

test('DELETE of an invoice paid by credit notes reverses its commission (unpaid: true) before the row goes', async () => {
  const res = await request(app).delete('/api/v1/invoices/900');
  expect(res.status).toBe(204);
  const { opts } = syncedOnTransaction();
  expect(opts).toEqual({ unpaid: true });
  const softDelete = conn.execute.mock.calls.findIndex(([q]) => /deleted_at = NOW\(\)/.test(q) && /invoices/.test(q));
  expect(softDelete).toBeGreaterThanOrEqual(0);
  expect(commissions.syncResellerCommission.mock.invocationCallOrder[0]).toBeLessThan(conn.execute.mock.invocationCallOrder[softDelete]);
});

test('restore re-derives the paid status, then syncs the commission, on the restore transaction', async () => {
  const res = await request(app).post('/api/v1/invoices/900/restore');
  expect(res.status).toBe(200);
  expect(billingService.refreshInvoicePaidStatus).toHaveBeenCalledWith(900, expect.any(Function));
  syncedOnTransaction();
  expect(billingService.refreshInvoicePaidStatus.mock.invocationCallOrder[0])
    .toBeLessThan(commissions.syncResellerCommission.mock.invocationCallOrder[0]);
  expect(conn.commit).toHaveBeenCalled();
});

test('restoring an invoice marked paid outside the system (an import: paid_at NULL) keeps it paid, and still syncs', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/FROM cfdi_documents/.test(sql)) return [[]];
    if (/SELECT \* FROM `?invoices`? WHERE id/.test(sql)) return [[{ ...PAID, paid_at: null }]];
    if (/^UPDATE `?invoices`?/i.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
  const res = await request(app).post('/api/v1/invoices/900/restore');
  expect(res.status).toBe(200);
  expect(billingService.refreshInvoicePaidStatus).not.toHaveBeenCalled();
  syncedOnTransaction();
});

test('a hand edit cannot write paid_at: it would move the invoice across the commission go-live point', async () => {
  const res = await request(app).patch('/api/v1/invoices/900').send({ paid_at: '2030-01-01 00:00:00', due_date: '2026-12-01' });
  expect(res.status).toBe(200);
  const writes = [...conn.execute.mock.calls, ...db.query.mock.calls]
    .filter(([q]) => /^\s*UPDATE `?invoices`?/i.test(q));
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.some(([q]) => /paid_at/.test(q))).toBe(false);
  syncedOnTransaction();
});
