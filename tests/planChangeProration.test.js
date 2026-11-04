// =============================================================================
// A staff or batch plan change bills the rest of the invoiced period
// =============================================================================
// Periods are invoiced up front at the plan price of that moment. Only an
// approved portal request billed a mid-period change (BIL-23); a staff or
// batch change billed nothing, so an upgrade rode the faster plan free until
// the next period and a downgrade paid the old price for days on the slower
// one.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('../src/utils/businessDate', () => ({
  ...jest.requireActual('../src/utils/businessDate'),
  businessToday: () => '2026-11-11',
}));

const db = require('../src/config/database');
const billingService = require('../src/services/billingService');
const creditNoteLedgerService = require('../src/services/creditNoteLedgerService');
const Organization = require('../src/models/Organization');
const { mockTxConnection } = require('./fixtures/mockTxConnection');
const { prorate, prorationFor } = require('../src/services/planChangeProrationService');

const CONTRACT = { id: 8, client_id: 12, plan_id: 2, price_override: null };
const PLANS = [{ id: 2, name: 'Basic', price: '300.00' }, { id: 3, name: 'Fiber Pro', price: '600.00' }];
// November: 30 days; the change on the 11th leaves 20.
const PERIOD = { period_start: new Date('2026-11-01T00:00:00Z'), period_end: new Date('2026-11-30T00:00:00Z') };

let conn;
function wire({ plans = PLANS, periods = [PERIOD] } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM plans/.test(sql)) return [plans];
    if (/FROM billing_periods/.test(sql)) return [periods];
    if (/INSERT INTO credit_notes/.test(sql)) return [{ insertId: 91 }];
    return [[]];
  });
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  conn = mockTxConnection(db);
  jest.spyOn(billingService, 'createOneOffInvoice').mockResolvedValue({ id: 500 });
  jest.spyOn(billingService, 'resolveTaxContext').mockResolvedValue({ rate: 0.16, taxRateId: 2 });
  jest.spyOn(creditNoteLedgerService, 'syncCreditNoteLedger').mockResolvedValue(undefined);
  jest.spyOn(Organization, 'getCurrency').mockResolvedValue('MXN');
});

test('an upgrade on the 11th bills 20 of 30 days at the difference, on the change\'s transaction', async () => {
  wire();
  const result = await prorate(conn, { contract: CONTRACT, newPlanId: 3, organizationId: 4, actorId: 7 });
  expect(result).toEqual({ net: 200, invoice: { id: 500 } });
  expect(billingService.createOneOffInvoice).toHaveBeenCalledWith(expect.objectContaining({
    orgId: 4, clientId: 12, contractId: 8, amount: 200, conn, performedBy: 7,
    description: 'Plan change proration: Basic -> Fiber Pro (20 of 30 days)',
  }));
  // Every read ran on the transaction, none on the pool.
  expect(conn.execute.mock.calls.length).toBeGreaterThan(0);
});

test('a downgrade issues a credit note for the unused days, posted to the ledger', async () => {
  wire();
  const result = await prorate(conn, { contract: { ...CONTRACT, plan_id: 3 }, newPlanId: 2, organizationId: 4, actorId: 7 });
  expect(result).toEqual({ net: -200, creditNoteId: 91 });
  const insert = conn.execute.mock.calls.find(([sql]) => /INSERT INTO credit_notes/.test(sql));
  // subtotal 200, 16% tax 32, total 232, issued.
  expect(insert[1]).toEqual(expect.arrayContaining([4, 12, 8, '2026-11-11', 200, 0.16, 32, 232, 'MXN', 2, 7]));
  expect(insert[1][3]).toMatch(/^PCN-C8-\d+$/);
  expect(creditNoteLedgerService.syncCreditNoteLedger).toHaveBeenCalledWith(
    expect.any(Function), expect.objectContaining({ id: 91, total: 232, status: 'issued' }), 4,
  );
  expect(billingService.createOneOffInvoice).not.toHaveBeenCalled();
});

test('nothing to bill: a price override, no invoiced period, or a finished period', async () => {
  wire();
  expect(await prorationFor(conn.execute, { ...CONTRACT, price_override: '450.00' }, 3, 4)).toBeNull();
  wire({ periods: [] });
  expect(await prorationFor(conn.execute, CONTRACT, 3, 4)).toBeNull();
  wire({ periods: [{ period_start: new Date('2026-10-01T00:00:00Z'), period_end: new Date('2026-10-31T00:00:00Z') }] });
  expect(await prorate(conn, { contract: CONTRACT, newPlanId: 3, organizationId: 4 })).toBeNull();
  expect(billingService.createOneOffInvoice).not.toHaveBeenCalled();
});

test('a plan of another organization is not priced', async () => {
  wire({ plans: [PLANS[0]] });
  expect(await prorationFor(conn.execute, CONTRACT, 3, 4)).toBeNull();
  const [sql, params] = conn.execute.mock.calls[0];
  expect(sql).toMatch(/organization_id = \? OR organization_id IS NULL/);
  expect(params).toEqual([2, 3, 4]);
});
