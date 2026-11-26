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
  expect(result).toEqual({ net: 200, invoice: { id: 500 }, aheadMonths: 0, freed: 0 });
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
  expect(result).toEqual({ net: -200, creditNoteId: 91, aheadMonths: 0, aheadCreditNoteIds: [], freed: 0 });
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

// ---------------------------------------------------------------------------
// Months billed ahead (services/billAheadService.js)
// ---------------------------------------------------------------------------
const DECEMBER = { period_start: new Date('2026-12-01T00:00:00Z'), period_end: new Date('2026-12-31T00:00:00Z'), invoice_id: 701 };
const JANUARY = { period_start: new Date('2027-01-01T00:00:00Z'), period_end: new Date('2027-01-31T00:00:00Z'), invoice_id: 702 };

test('the period that contains today is the one prorated by days, not the latest one invoiced', async () => {
  wire({ periods: [PERIOD, DECEMBER, JANUARY] });
  const p = await prorationFor(conn.execute, CONTRACT, 3, 4);
  expect(p).toMatchObject({ daysRemaining: 20, totalDays: 30, currentNet: 200, aheadMonths: 2, aheadNet: 600, net: 800, monthDifference: 300 });
  expect(p.aheadInvoiceIds).toEqual([701, 702]);
  // Only periods that are not over are read.
  const [sql, params] = conn.execute.mock.calls.find(([q]) => /FROM billing_periods/.test(q));
  expect(sql).toMatch(/bp\.period_end >= \?/);
  expect(params).toEqual([4, 8, '2026-11-11']);
});

test('an upgrade bills the rest of this period and the whole difference of every month billed ahead, on one invoice', async () => {
  wire({ periods: [PERIOD, DECEMBER, JANUARY] });
  const result = await prorate(conn, { contract: CONTRACT, newPlanId: 3, organizationId: 4, actorId: 7 });
  expect(result).toMatchObject({ net: 800, aheadMonths: 2, freed: 0 });
  expect(billingService.createOneOffInvoice).toHaveBeenCalledTimes(1);
  expect(billingService.createOneOffInvoice).toHaveBeenCalledWith(expect.objectContaining({
    amount: 800, description: 'Plan change proration: Basic -> Fiber Pro (20 of 30 days), and 2 month(s) billed ahead',
  }));
});

test('months billed ahead are adjusted even when there is no current period', async () => {
  wire({ periods: [DECEMBER] });
  const result = await prorate(conn, { contract: CONTRACT, newPlanId: 3, organizationId: 4 });
  expect(result.net).toBe(300);
  expect(billingService.createOneOffInvoice).toHaveBeenCalledWith(expect.objectContaining({
    amount: 300, description: 'Plan change proration: Basic -> Fiber Pro, and 1 month(s) billed ahead',
  }));
});

describe('a downgrade with months billed ahead', () => {
  const DOWN = { ...CONTRACT, plan_id: 3 };
  let allocationWrites;
  let noteInserts;

  function world({ invoices, allocations, rep = [] }) {
    allocationWrites = [];
    noteInserts = [];
    let noteId = 90;
    db.query.mockImplementation(async (sql, params) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (/FROM plans/.test(text)) return [PLANS];
      if (/FROM billing_periods/.test(text)) return [[PERIOD, DECEMBER, JANUARY]];
      if (/^SELECT id, client_id, subtotal, tax_rate/.test(text)) return [invoices[params[0]] ? [invoices[params[0]]] : []];
      if (/^SELECT id, payment_id, amount FROM payment_allocations/.test(text)) return [allocations[params[0]] || []];
      if (/FROM cfdi_documents d/.test(text)) return [rep.includes(params[1]) ? [{ id: 1, uuid: 'u', sat_status: 'vigente' }] : []];
      if (/^UPDATE payment_allocations/.test(text)) { allocationWrites.push([text, params]); return [{ affectedRows: 1 }]; }
      if (/^INSERT INTO credit_notes/.test(text)) { noteId += 1; noteInserts.push(params); return [{ insertId: noteId }]; }
      return [[]];
    });
  }
  const inv = (id, over = {}) => ({ id, client_id: 12, subtotal: '600.00', tax_rate: '0.1600', tax_rate_id: 2, total: '696.00', currency: 'MXN', status: 'paid', ...over });

  beforeEach(() => {
    jest.spyOn(require('../src/services/creditNoteApplicationService'), 'syncApplication').mockResolvedValue(0);
  });

  test('each month keeps its invoice: a credit note covers the difference and that much of the payment is freed', async () => {
    world({
      invoices: { 701: inv(701), 702: inv(702) },
      allocations: { 701: [{ id: 1, payment_id: 50, amount: '696.00' }], 702: [{ id: 2, payment_id: 50, amount: '696.00' }] },
    });
    const result = await prorate(conn, { contract: DOWN, newPlanId: 2, organizationId: 4, actorId: 7 });

    // 300 less a month, 16% tax: 348 per month comes off the payment.
    expect(result.aheadMonths).toBe(2);
    expect(result.freed).toBe(696);
    expect(result.aheadCreditNoteIds).toEqual([92, 93]);
    expect(allocationWrites.map(([, params]) => params)).toEqual([[348, 1], [348, 2]]);
    // The days left of this period are plain credit on the account; the two
    // months' notes are tied to their invoices.
    const [current, december, january] = noteInserts;
    expect(current[3]).toMatch(/^PCN-C8-\d+$/);
    expect(december.slice(0, 4)).toEqual([4, 12, 8, 701]);
    expect(december.slice(6, 12)).toEqual([300, '0.1600', 48, 348, 'MXN', 2]);
    expect(january[3]).toBe(702);
    expect(billingService.createOneOffInvoice).not.toHaveBeenCalled();
    const sync = require('../src/services/creditNoteApplicationService').syncApplication;
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync.mock.calls[0][1]).toMatchObject({ invoice_id: 701, total: 348, status: 'issued' });
  });

  test('a month paid only in part gives up only what the credit note needs beyond what it still owes', async () => {
    // January: 696 owed, 100 paid. The note (348) fits in the 596 still owed: nothing is freed.
    world({
      invoices: { 701: inv(701), 702: inv(702, { status: 'issued' }) },
      allocations: { 701: [{ id: 1, payment_id: 50, amount: '696.00' }], 702: [{ id: 2, payment_id: 50, amount: '100.00' }] },
    });
    const result = await prorate(conn, { contract: DOWN, newPlanId: 2, organizationId: 4 });
    expect(result.freed).toBe(348);
    expect(allocationWrites.map(([, params]) => params)).toEqual([[348, 1]]);
  });

  test('an allocation is removed when all of it is freed, newest first', async () => {
    world({
      invoices: { 701: inv(701), 702: inv(702) },
      allocations: {
        701: [{ id: 3, payment_id: 51, amount: '200.00' }, { id: 1, payment_id: 50, amount: '496.00' }],
        702: [{ id: 2, payment_id: 50, amount: '696.00' }],
      },
    });
    await prorate(conn, { contract: DOWN, newPlanId: 2, organizationId: 4 });
    const [first, second] = allocationWrites;
    expect(first[0]).toMatch(/SET deleted_at = NOW\(\) WHERE id = \?/);
    expect(first[1]).toEqual([3]);
    expect(second[1]).toEqual([348, 1]);
  });

  test('a payment already reported to SAT with a complement for that invoice is left where it is', async () => {
    world({
      invoices: { 701: inv(701), 702: inv(702) },
      allocations: { 701: [{ id: 1, payment_id: 50, amount: '696.00' }], 702: [{ id: 2, payment_id: 60, amount: '696.00' }] },
      rep: [50],
    });
    const result = await prorate(conn, { contract: DOWN, newPlanId: 2, organizationId: 4 });
    // December's payment has a complement: untouched. January's is freed.
    expect(allocationWrites.map(([, params]) => params)).toEqual([[348, 2]]);
    expect(result.freed).toBe(348);
    // Both months still get their credit note; December's stays as credit on the account.
    expect(result.aheadCreditNoteIds.length).toBe(2);
  });

  test('an invoice that is gone or cancelled is skipped', async () => {
    world({ invoices: { 702: inv(702) }, allocations: { 702: [{ id: 2, payment_id: 50, amount: '696.00' }] } });
    const result = await prorate(conn, { contract: DOWN, newPlanId: 2, organizationId: 4 });
    expect(result.aheadCreditNoteIds.length).toBe(1);
    expect(result.freed).toBe(348);
  });
});
