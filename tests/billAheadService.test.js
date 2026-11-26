'use strict';
// Paying ahead bills ahead: which months are invoiced with a client's credit,
// in what order, and when it stops. The real billing run, credit application
// and locks are exercised in tests/integration/db/billAhead.test.js.

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/utils/advisoryLock', () => ({ withAdvisoryLock: jest.fn() }));
jest.mock('../src/services/billingService', () => ({
  generateBillingPeriod: jest.fn(), generateInvoice: jest.fn(), isContractInTrial: jest.fn(),
}));
jest.mock('../src/services/clientCreditService', () => ({ applyCredit: jest.fn() }));
jest.mock('../src/services/invoiceCfdiService', () => ({ autoStampInvoice: jest.fn().mockResolvedValue({ attempted: false }) }));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/models/Organization', () => ({ getCurrency: jest.fn().mockResolvedValue('MXN') }));
jest.mock('../src/utils/businessDate', () => ({ businessToday: () => '2026-11-26' }));

const db = require('../src/config/database');
const { withAdvisoryLock } = require('../src/utils/advisoryLock');
const billing = require('../src/services/billingService');
const credit = require('../src/services/clientCreditService');
const cfdi = require('../src/services/invoiceCfdiService');
const service = require('../src/services/billAheadService');

const contract = (over = {}) => ({
  id: 1, organization_id: 5, client_id: 9, plan_name: 'Fibra 100', plan_price: '100.00', plan_currency: 'MXN',
  plan_trial_days: 0, plan_overage_mode: 'none', price_override: null, ...over,
});

// A client holding `money`, with these contracts; each invoice costs `price`.
function world({ money, contracts = [contract()], price = 100, owed = 0, currency = 'MXN' }) {
  const state = { money, owed, periods: new Map(), invoices: [], flagged: [] };
  withAdvisoryLock.mockImplementation(async (_key, fn) => { await fn(); return true; });
  billing.isContractInTrial.mockImplementation((c) => Boolean(c.in_trial));
  db.query.mockImplementation(async (sql, params) => {
    if (/SUM\(/.test(sql) && /GROUP BY p\.currency/.test(sql)) return [state.money > 0.005 ? [{ currency, credit: state.money }] : []];
    if (/FROM contracts c/.test(sql)) return [contracts];
    if (/^UPDATE invoices SET billed_ahead = 1/.test(sql)) { state.flagged.push(params[0]); return [{ affectedRows: 1 }]; }
    if (/SELECT DISTINCT p\.client_id/.test(sql)) return [state.sweepClients || []];
    return [[]];
  });
  billing.generateBillingPeriod.mockImplementation(async (c) => {
    const n = state.periods.get(c.id) ?? (c.first_month ?? 12);
    const month = ((n - 1) % 12) + 1;
    const year = 2026 + Math.floor((n - 1) / 12);
    const mm = String(month).padStart(2, '0');
    return { id: c.id * 1000 + n, contract_id: c.id, status: 'pending', period_start: `${year}-${mm}-01`, period_end: `${year}-${mm}-28`, scheduled_at: `${year}-${mm}-01`, n };
  });
  billing.generateInvoice.mockImplementation(async (period, c) => {
    state.periods.set(c.id, period.n + 1);
    const inv = { id: 100 + state.invoices.length, invoice_number: `INV-${100 + state.invoices.length}`, client_id: c.client_id, total: price, due: price, contract_id: c.id, period };
    state.invoices.push(inv);
    return inv;
  });
  credit.applyCredit.mockImplementation(async () => {
    let applied = 0; const paid = [];
    if (state.refuse) return { allocations: [], applied: 0, paid_invoice_ids: [] };
    if (state.owed > 0) { const a = Math.min(state.owed, state.money); state.owed -= a; state.money -= a; applied += a; }
    for (const inv of state.invoices) {
      if (inv.due <= 0 || state.money <= 0.005) continue;
      const a = Math.min(inv.due, state.money); inv.due -= a; state.money -= a; applied += a;
      if (inv.due <= 0.005) paid.push(inv.id);
    }
    return { allocations: [], applied, paid_invoice_ids: paid };
  });
  return state;
}

beforeEach(() => jest.clearAllMocks());

describe('billAhead', () => {
  it('invoices month after month until the money runs out; the last one is paid in part', async () => {
    const state = world({ money: 250 });
    const out = await service.billAhead({ orgId: 5, clientId: 9, actorUserId: 3 });
    expect(out.ran).toBe(true);
    expect(out.invoices.map((i) => [i.period_start, i.paid])).toEqual([['2026-12-01', true], ['2027-01-01', true], ['2027-02-01', false]]);
    expect(out.applied).toBe(250);
    expect(state.money).toBeLessThan(0.005);
    expect(billing.generateInvoice).toHaveBeenCalledTimes(3);
  });

  it('pays what the client already owes first, and invoices ahead only with what is left', async () => {
    const state = world({ money: 350, owed: 300 });
    const out = await service.billAhead({ orgId: 5, clientId: 9 });
    expect(state.owed).toBe(0);
    expect(out.invoices.length).toBe(1);
    expect(out.invoices[0].paid).toBe(false);
    expect(out.applied).toBe(350);
  });

  it('with no credit, invoices nothing', async () => {
    world({ money: 0 });
    const out = await service.billAhead({ orgId: 5, clientId: 9 });
    expect(out.invoices).toEqual([]);
    expect(billing.generateInvoice).not.toHaveBeenCalled();
  });

  it('marks a month as billed ahead only when its billing day has not come', async () => {
    // First month is this November (already due), then December and on.
    const state = world({ money: 200, contracts: [contract({ first_month: 11 })] });
    const out = await service.billAhead({ orgId: 5, clientId: 9 });
    expect(out.invoices.map((i) => [i.period_start, i.billed_ahead])).toEqual([['2026-11-01', false], ['2026-12-01', true]]);
    expect(state.flagged).toEqual([101]);
  });

  it('with two contracts, the month that starts first is invoiced first', async () => {
    world({ money: 300, contracts: [contract({ id: 1, first_month: 13 }), contract({ id: 2, first_month: 12 })] });
    const out = await service.billAhead({ orgId: 5, clientId: 9 });
    expect(out.invoices.map((i) => [i.contract_id, i.period_start])).toEqual([[2, '2026-12-01'], [1, '2027-01-01'], [2, '2027-01-01']]);
  });

  it('does not bill ahead a contract in trial, a plan with data overage, or a free plan', async () => {
    world({ money: 500, contracts: [contract({ id: 1, in_trial: true }), contract({ id: 2, plan_overage_mode: 'per_gb' }), contract({ id: 3, plan_price: '0.00' })] });
    const out = await service.billAhead({ orgId: 5, clientId: 9 });
    expect(out.invoices).toEqual([]);
    expect(billing.generateBillingPeriod).not.toHaveBeenCalled();
  });

  it('uses the contract\'s own price when it has one', async () => {
    world({ money: 100, contracts: [contract({ plan_price: '0.00', price_override: '80.00' })], price: 80 });
    const out = await service.billAhead({ orgId: 5, clientId: 9 });
    expect(out.invoices.length).toBe(2);
  });

  it('does not invoice a contract whose currency the credit is not in', async () => {
    world({ money: 500, currency: 'USD' });
    const out = await service.billAhead({ orgId: 5, clientId: 9 });
    expect(out.invoices).toEqual([]);
    expect(billing.generateInvoice).not.toHaveBeenCalled();
  });

  it('stops after one invoice when the credit cannot pay it', async () => {
    const state = world({ money: 500 });
    credit.applyCredit.mockResolvedValueOnce({ allocations: [], applied: 0, paid_invoice_ids: [] });
    state.refuse = true;
    const out = await service.billAhead({ orgId: 5, clientId: 9 });
    expect(out.invoices.length).toBe(1);
    expect(billing.generateInvoice).toHaveBeenCalledTimes(1);
  });

  it('never invoices more than the limit of months ahead', async () => {
    world({ money: 1e9 });
    const out = await service.billAhead({ orgId: 5, clientId: 9 });
    expect(out.invoices.length).toBe(service.MAX_PERIODS_AHEAD);
  });

  it('stamps each invoice when the organization stamps automatically, and a stamping failure does not stop the run', async () => {
    world({ money: 200 });
    cfdi.autoStampInvoice.mockRejectedValueOnce(new Error('PAC down'));
    const out = await service.billAhead({ orgId: 5, clientId: 9 });
    expect(out.invoices.length).toBe(2);
    expect(cfdi.autoStampInvoice).toHaveBeenCalledTimes(2);
    expect(cfdi.autoStampInvoice).toHaveBeenCalledWith(100, 5);
  });

  it('steps aside when the same client is already being billed ahead', async () => {
    world({ money: 500 });
    withAdvisoryLock.mockResolvedValue(false);
    const out = await service.billAhead({ orgId: 5, clientId: 9 });
    expect(out).toMatchObject({ ran: false, invoices: [] });
    expect(withAdvisoryLock.mock.calls[0][0]).toBe('bill-ahead:5:9');
  });

  it('needs the organization, and does nothing without a client', async () => {
    world({ money: 500 });
    await expect(service.billAhead({ clientId: 9 })).rejects.toThrow();
    expect(await service.billAhead({ orgId: 5, clientId: null })).toMatchObject({ invoices: [], ran: false });
  });
});

describe('billAheadQuietly and the sweep', () => {
  it('never throws: a failure is reported, for the daily sweep to retry', async () => {
    world({ money: 500 });
    withAdvisoryLock.mockRejectedValue(new Error('lock pool down'));
    expect(await service.billAheadQuietly({ orgId: 5, clientId: 9 })).toMatchObject({ failed: true, invoices: [] });
  });

  it('the sweep bills ahead every client still holding credit', async () => {
    const state = world({ money: 150 });
    state.sweepClients = [{ client_id: 9 }, { client_id: 10 }];
    const out = await service.sweepOrg(5);
    // The first client uses the money; the second finds none.
    expect(out).toEqual({ clients: 1, invoices: 2, failed: 0 });
  });
});
