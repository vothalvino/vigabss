// =============================================================================
// Client credit pays the next invoices on its own (migration 012)
// =============================================================================
// services/clientCreditService.js: a client's payments with an unallocated
// remainder, oldest first, run the allocate-auto waterfall over its payable
// invoices (never one staff kept off credit), in one transaction that locks
// the payments, then the invoices; after commit, reconnect and REP. The hooks:
// the monthly run before an invoice is emailed or stamped, the suspension
// run's sweep, a one-off invoice, and a manual invoice unless "Use the
// customer's credit" was unticked.
// =============================================================================
'use strict';

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('../src/services/paymentAllocationService', () => ({
  PAYABLE_STATUSES: ['issued', 'sent', 'overdue'],
  isPaymentSettled: jest.fn((p) => p.status === 'completed'),
  lockInvoicesForAllocation: jest.fn(async () => {}),
  getInvoicesWithBalance: jest.fn(),
  allocationRefusal: jest.fn(() => null),
  allocateAcrossInvoices: jest.fn(),
  reconnectIfSuspended: jest.fn(async () => true),
}));
jest.mock('../src/services/repService', () => ({ maybeGenerateRep: jest.fn(async () => ({ generated: false })) }));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn(async () => {}) }));

const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const pas = require('../src/services/paymentAllocationService');
const repService = require('../src/services/repService');
const credit = require('../src/services/clientCreditService');

const ORG = 1;
let conn;
let order;

beforeEach(() => {
  jest.clearAllMocks();
  order = [];
  conn = {
    beginTransaction: jest.fn(async () => order.push('begin')),
    commit: jest.fn(async () => order.push('commit')),
    rollback: jest.fn(async () => order.push('rollback')),
    release: jest.fn(),
    execute: jest.fn(async (sql) => {
      if (/FROM payments p/.test(sql) && /FOR UPDATE/.test(sql)) {
        order.push('lock payments');
        return [[
          { id: 12, organization_id: ORG, client_id: 7, status: 'completed', amount: '300.00', remainder: '300.00', payment_date: '2026-11-05', currency: 'MXN' },
          { id: 9, organization_id: ORG, client_id: 7, status: 'completed', amount: '100.00', remainder: '50.00', payment_date: '2026-11-01', currency: 'MXN' },
        ]];
      }
      return [[]];
    }),
  };
  db.getConnection.mockResolvedValue(conn);
  db.query.mockImplementation(async (sql) => {
    if (/SELECT p\.id FROM payments p/.test(sql)) return [[{ id: 9 }, { id: 12 }]];
    return [[]];
  });
  pas.lockInvoicesForAllocation.mockImplementation(async () => order.push('lock invoices'));
});

test('applies the oldest payment first, over the payable invoices, never one kept off credit', async () => {
  pas.getInvoicesWithBalance.mockResolvedValue([
    { id: 81, client_id: 7, status: 'issued', balance_due: '200.00', apply_client_credit: 1 },
    { id: 82, client_id: 7, status: 'issued', balance_due: '90.00', apply_client_credit: 0 },
  ]);
  pas.allocateAcrossInvoices
    .mockResolvedValueOnce({ allocations: [{ invoice_id: 81, amount: 50 }], justPaidInvoices: [], remainder: 0 })
    .mockResolvedValueOnce({ allocations: [{ invoice_id: 81, amount: 150 }], justPaidInvoices: [{ id: 81, contract_id: 3 }], remainder: 150 });
  const out = await credit.applyCredit({ orgId: ORG, clientId: 7, actorUserId: 5 });
  // Payment 9 (1 Nov) before payment 12 (5 Nov); invoice 82 is not offered.
  expect(pas.allocateAcrossInvoices.mock.calls.map(([, a]) => [a.payment.id, a.amount, a.invoices.map((i) => i.id)]))
    .toEqual([[9, 50, [81]], [12, 300, [81]]]);
  expect(out).toEqual({
    allocations: [{ payment_id: 9, invoice_id: 81, amount: 50 }, { payment_id: 12, invoice_id: 81, amount: 150 }],
    applied: 200,
    paid_invoice_ids: [81],
  });
  // Payments, then invoices; reconnect and REP only after the commit.
  expect(order).toEqual(['begin', 'lock payments', 'lock invoices', 'commit']);
  expect(pas.reconnectIfSuspended).toHaveBeenCalledWith({ id: 81, contract_id: 3 }, 5, ORG);
  expect(repService.maybeGenerateRep.mock.calls.map((c) => c.slice(0, 3))).toEqual([[9, 81, 50], [12, 81, 150]]);
});

test('a client without credit costs one read and no transaction', async () => {
  db.query.mockResolvedValue([[]]);
  expect(await credit.applyCredit({ orgId: ORG, clientId: 7 })).toEqual({ allocations: [], applied: 0, paid_invoice_ids: [] });
  expect(db.getConnection).not.toHaveBeenCalled();
});

test('a failure rolls back; applyCreditQuietly reports it instead of throwing', async () => {
  pas.getInvoicesWithBalance.mockResolvedValue([{ id: 81, client_id: 7, status: 'issued', balance_due: '200.00' }]);
  pas.allocateAcrossInvoices.mockRejectedValue(new Error('deadlock'));
  await expect(credit.applyCredit({ orgId: ORG, clientId: 7 })).rejects.toThrow('deadlock');
  expect(order).toContain('rollback');
  expect(await credit.applyCreditQuietly({ orgId: ORG, clientId: 7 })).toMatchObject({ applied: 0, failed: true });
});

test('the sweep visits only clients with credit and an invoice that takes it', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/SELECT DISTINCT p\.client_id/.test(sql)) {
      expect(sql).toMatch(/i\.apply_client_credit = 1/);
      return [[{ client_id: 7 }, { client_id: 8 }]];
    }
    return [[]];
  });
  const spy = jest.spyOn(credit, 'applyCreditQuietly');
  const out = await credit.sweepOrg(ORG);
  expect(out).toEqual({ clients: 0, applied: 0, failed: 0 });
  spy.mockRestore();
});

describe('the hooks', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

  test('the monthly run applies credit right after creating an invoice, before it is emailed or stamped', () => {
    const run = src('services/taskRunner.js');
    const gen = run.indexOf('await billingService.generateInvoice(period, contract, plan, contract.organization_id);');
    const apply = run.indexOf("require('./clientCreditService').applyCreditQuietly({ orgId: contract.organization_id, clientId: invoice.client_id })");
    const email = run.indexOf('// Send invoice notification email to client');
    const stamp = run.indexOf('autoStampInvoice(invoice.id, contract.organization_id)');
    expect(gen).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(gen);
    expect(apply).toBeLessThan(email);
    expect(apply).toBeLessThan(stamp);
  });

  test('the suspension run sweeps credit before evaluating the rules', () => {
    const run = src('services/taskRunner.js');
    const sweep = run.indexOf("require('./clientCreditService').sweepOrg(org.id)");
    const rules = run.indexOf('await suspensionService.evaluateRules(org.id);');
    expect(sweep).toBeGreaterThan(0);
    expect(sweep).toBeLessThan(rules);
  });

  test('a one-off invoice on its own transaction applies credit after the commit', () => {
    const billing = src('services/billingService.js');
    const commit = billing.indexOf('await conn.commit();\n      invoice = await Invoice.findById(invoiceId, orgId);');
    const apply = billing.indexOf("require('./clientCreditService').applyCreditQuietly({ orgId, clientId, actorUserId: performedBy })");
    expect(commit).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(commit);
  });
});
