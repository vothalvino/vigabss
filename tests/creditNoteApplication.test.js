// =============================================================================
// BIL-14 — a credit note reduces the invoice it credits
// =============================================================================
// POST /credit-notes only posted a ledger credit. balance_due everywhere was
// total minus payment allocations, so after staff fully credited an invoice,
// autopay still charged it, the portal Pay button charged the full total, late
// fees accrued and suspension fired. No code ever set a note to 'applied'.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const service = require('../src/services/creditNoteApplicationService');

// A small in-memory model of the three tables syncApplication touches.
function fakeDb({ invoice, applications = [], notes = [] }) {
  const state = { invoice: { ...invoice }, applications: applications.map((a) => ({ ...a })), notes: notes.map((n) => ({ ...n })) };
  let nextId = 100;
  const live = () => state.applications.filter((a) => !a.deleted_at);
  const exec = jest.fn(async (sql, p = []) => {
    if (/^SELECT id, invoice_id, amount FROM credit_note_applications WHERE credit_note_id = \?/.test(sql)) {
      return [live().filter((a) => a.credit_note_id === p[0])];
    }
    if (/^SELECT credit_note_id FROM credit_note_applications WHERE invoice_id = \?/.test(sql)) {
      return [live().filter((a) => a.invoice_id === p[0]).map((a) => ({ credit_note_id: a.credit_note_id }))];
    }
    if (/FROM invoices i/.test(sql)) {
      const inv = state.invoice;
      if (Number(p[0]) !== inv.id) return [[]];
      if (/i\.status IN/.test(sql) && !['issued', 'sent', 'overdue', 'paid'].includes(inv.status)) return [[]];
      const credited = live().filter((a) => a.invoice_id === inv.id).reduce((s, a) => s + Number(a.amount), 0);
      return [[{ id: inv.id, total: inv.total, status: inv.status, covered: Number(inv.allocated || 0) + credited }]];
    }
    if (/^UPDATE credit_note_applications SET deleted_at = NOW\(\) WHERE id = \?/.test(sql)) {
      state.applications.find((a) => a.id === p[0]).deleted_at = 'now';
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE credit_note_applications SET deleted_at = NOW\(\) WHERE invoice_id = \?/.test(sql)) {
      live().filter((a) => a.invoice_id === p[0]).forEach((a) => { a.deleted_at = 'now'; });
      return [{ affectedRows: 1 }];
    }
    if (/^INSERT INTO credit_note_applications/.test(sql)) {
      state.applications.push({ id: nextId++, credit_note_id: p[0], invoice_id: p[1], amount: p[2], deleted_at: null });
      return [{ insertId: nextId }];
    }
    if (/^UPDATE invoices SET status = 'paid'/.test(sql)) {
      if (['issued', 'sent', 'overdue'].includes(state.invoice.status)) state.invoice.status = 'paid';
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE invoices SET status = 'issued'/.test(sql)) {
      if (state.invoice.status === 'paid') state.invoice.status = 'issued';
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE credit_notes SET status = \?/.test(sql)) {
      state.noteStatus = p[0];
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE credit_notes SET status = 'issued'/.test(sql)) {
      state.notes.filter((n) => n.id === p[0] && n.status === 'applied').forEach((n) => { n.status = 'issued'; });
      return [{ affectedRows: 1 }];
    }
    throw new Error(`fake db: unhandled ${sql.slice(0, 80)}`);
  });
  return { state, exec };
}

const INVOICE = { id: 60, total: '1160.00', status: 'issued', allocated: 0 };
const note = (over) => ({ id: 40, client_id: 42, invoice_id: 60, total: '1160.00', status: 'issued', deleted_at: null, ...over });

describe('syncApplication', () => {
  test('a full credit settles the invoice and the note turns applied', async () => {
    const { state, exec } = fakeDb({ invoice: INVOICE });
    const applied = await service.syncApplication(exec, note(), 5);
    expect(applied).toBe(1160);
    expect(state.applications).toEqual([expect.objectContaining({ credit_note_id: 40, invoice_id: 60, amount: 1160 })]);
    expect(state.invoice.status).toBe('paid');
    expect(state.noteStatus).toBe('applied');
  });

  test('a partial credit lowers what the invoice owes and leaves it issued', async () => {
    const { state, exec } = fakeDb({ invoice: INVOICE });
    await service.syncApplication(exec, note({ total: '400.00' }), 5);
    expect(state.applications[0].amount).toBe(400);
    expect(state.invoice.status).toBe('issued');
    expect(state.noteStatus).toBe('applied');
  });

  test('a note larger than what is owed applies only that, and keeps the rest as credit', async () => {
    const { state, exec } = fakeDb({ invoice: { ...INVOICE, allocated: 1000 } });
    await service.syncApplication(exec, note({ total: '500.00' }), 5);
    expect(state.applications[0].amount).toBe(160);
    expect(state.invoice.status).toBe('paid');
    expect(state.noteStatus).toBeUndefined(); // stays 'issued': 340 still stands as credit
  });

  test('re-running it changes nothing', async () => {
    const { state, exec } = fakeDb({ invoice: INVOICE });
    await service.syncApplication(exec, note({ total: '400.00' }), 5);
    await service.syncApplication(exec, note({ total: '400.00', status: 'applied' }), 5);
    expect(state.applications).toHaveLength(1);
  });

  test('cancelling the note releases it and the invoice owes again', async () => {
    const { state, exec } = fakeDb({ invoice: INVOICE });
    await service.syncApplication(exec, note(), 5);
    expect(state.invoice.status).toBe('paid');
    await service.syncApplication(exec, note({ status: 'cancelled' }), 5);
    expect(state.applications.every((a) => a.deleted_at)).toBe(true);
    expect(state.invoice.status).toBe('issued');
  });

  test('a draft or invoice-less note applies nothing', async () => {
    for (const n of [note({ status: 'draft' }), note({ invoice_id: null })]) {
      const { state, exec } = fakeDb({ invoice: INVOICE });
      await service.syncApplication(exec, n, 5);
      expect(state.applications).toHaveLength(0);
    }
  });

  test('releaseForInvoice frees every note applied to a voided invoice', async () => {
    const { state, exec } = fakeDb({
      invoice: INVOICE,
      applications: [{ id: 1, credit_note_id: 40, invoice_id: 60, amount: '1160.00', deleted_at: null }],
      notes: [{ id: 40, status: 'applied' }],
    });
    expect(await service.releaseForInvoice(exec, 60)).toEqual([40]);
    expect(state.applications[0].deleted_at).toBe('now');
    expect(state.notes[0].status).toBe('issued');
  });
});

describe('every open balance subtracts applied credit', () => {
  const credit = /credit_note_applications cna\s+WHERE cna\.invoice_id = i\.id AND cna\.deleted_at IS NULL/;

  test('getInvoicesWithBalance (allocation waterfall, client balance, gateway reconcile)', async () => {
    const { getInvoicesWithBalance } = require('../src/services/paymentAllocationService');
    const exec = jest.fn().mockResolvedValue([[]]);
    await getInvoicesWithBalance(exec, 5, 42, null, false);
    expect(exec.mock.calls[0][0]).toMatch(credit);
  });

  test('finalizeIfFullyPaid counts credit toward settling', async () => {
    const { finalizeIfFullyPaid } = require('../src/services/paymentAllocationService');
    const exec = jest.fn()
      .mockResolvedValueOnce([[{ total_allocated: '760.00' }, { total_allocated: '400.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    await expect(finalizeIfFullyPaid(exec, { id: 60, total: '1160.00' })).resolves.toBe(true);
    expect(exec.mock.calls[0][0]).toMatch(/FROM credit_note_applications WHERE invoice_id = \?/);
  });

  test('refreshInvoicePaidStatus', async () => {
    const billingService = require('../src/services/billingService');
    db.query.mockResolvedValue([[]]);
    await billingService.refreshInvoicePaidStatus(60);
    expect(db.query.mock.calls[0][0]).toMatch(credit);
  });

  test.each([
    ['suspension', '../src/services/suspensionService'],
    ['payment retries', '../src/services/paymentRetryService'],
    ['client archive guard', '../src/routes/clients'],
    ['gateway refund reversal', '../src/services/paymentGatewayService'],
  ])('%s', (_name, mod) => {
    const src = require('fs').readFileSync(require.resolve(mod), 'utf8');
    expect(src).toMatch(/creditAppliedSql\('i'\)/);
  });
});

describe('the client balance counts only the unapplied part of a note', () => {
  test('a fully credited invoice nets to zero, not to a credit', async () => {
    const { computeClientBalance } = require('../src/services/clientBalanceService');
    db.query.mockImplementation(async (sql) => {
      if (/FROM invoices i/.test(sql)) return [[]]; // the credited invoice is paid: nothing payable
      if (/FROM payments p/.test(sql)) return [[]];
      if (/FROM credit_notes cn/.test(sql)) return [[{ total: '1160.00', applied: '1160.00', currency: 'MXN' }]];
      if (/FROM organizations/.test(sql)) return [[{ currency: 'MXN' }]];
      return [[]];
    });
    const { balance } = await computeClientBalance(5, 42);
    expect(balance).toBe(0);
  });
});

describe('online checkout charges what is still owed', () => {
  test('a partly credited invoice is charged its balance', async () => {
    const checkoutService = require('../src/services/checkoutService');
    const paymentGatewayService = require('../src/services/paymentGatewayService');
    const session = jest.spyOn(paymentGatewayService, 'createStripeCheckoutSession').mockResolvedValue({ id: 'cs_1', url: 'https://pay' });
    db.query.mockImplementation(async (sql) => {
      if (/FROM invoices i WHERE i\.id = \?/.test(sql)) {
        expect(sql).toMatch(/credit_note_applications/);
        return [[{ id: 60, client_id: 42, status: 'issued', total: '1160.00', balance_due: '760.00', currency: 'MXN', invoice_number: 'F-60' }]];
      }
      if (/FROM payment_gateways/.test(sql)) return [[{ id: 3, provider: 'stripe', secret_key_encrypted: 'sk' }]];
      if (/^\s*INSERT INTO payment_transactions/.test(sql)) return [{ insertId: 9 }];
      return [[]];
    });
    const res = await checkoutService.createCheckoutSession({ organizationId: 5, invoiceId: 60, clientId: 42 });
    expect(res.amount).toBe(760);
    expect(session.mock.calls[0][1].amount).toBe(760);
    const tx = db.query.mock.calls.find(([sql]) => /INSERT INTO payment_transactions/.test(sql));
    expect(tx[1]).toContain(760);
    session.mockRestore();
  });

  test('a fully credited invoice has nothing to pay', async () => {
    const checkoutService = require('../src/services/checkoutService');
    db.query.mockImplementation(async (sql) => (/FROM invoices i WHERE i\.id = \?/.test(sql)
      ? [[{ id: 60, client_id: 42, status: 'issued', total: '1160.00', balance_due: '0.00', currency: 'MXN', invoice_number: 'F-60' }]]
      : [[]]));
    await expect(checkoutService.createCheckoutSession({ organizationId: 5, invoiceId: 60, clientId: 42 }))
      .rejects.toThrow(/nothing left to pay/);
  });
});

describe('the credit-note routes apply and release', () => {
  jest.doMock('../src/middleware/auth', () => ({
    authenticate: (req, _res, next) => { req.user = { id: 8, role: 'admin' }; next(); },
  }));
  jest.doMock('../src/middleware/orgScope', () => ({
    orgScope: (req, _res, next) => { req.orgId = 5; next(); },
  }));
  jest.doMock('../src/middleware/rbac', () => ({
    userHasPermission: async () => true,
    requirePermission: () => (_req, _res, next) => next(),
    requireRole: () => (_req, _res, next) => next(),
  }));

  test('POST of an issued note against an invoice applies it', async () => {
    const request = require('supertest');
    const { mockTxConnection } = require('./fixtures/mockTxConnection');
    mockTxConnection(db);
    const sync = jest.spyOn(service, 'syncApplication').mockResolvedValue(116);
    db.query.mockImplementation(async (sql, params = []) => {
      if (/SELECT id FROM clients/.test(sql)) return [[{ id: 42 }]];
      if (/SELECT client_id FROM invoices/.test(sql)) return [[{ client_id: 42 }]];
      if (/SELECT id FROM invoices/.test(sql)) return [[{ id: Number(params[0]) }]];
      if (/^INSERT INTO `?credit_notes`?/.test(sql)) return [{ insertId: 41 }];
      if (/FROM `?credit_notes`?/.test(sql)) return [[{ id: 41, client_id: 42, invoice_id: 60, total: '116.00', currency: 'MXN', status: 'issued' }]];
      if (/^\s*INSERT/.test(sql)) return [{ insertId: 1 }];
      return [[]];
    });
    const app = require('../src/app');
    const res = await request(app).post('/api/v1/credit-notes')
      .send({ client_id: 42, invoice_id: 60, reason: 'billing_error', total: 116, currency: 'MXN', status: 'issued' });
    expect(res.status).toBe(201);
    expect(sync).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ id: 41, invoice_id: 60 }), 5);
    sync.mockRestore();
  });
});
