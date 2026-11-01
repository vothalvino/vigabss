// =============================================================================
// BIL-23 — an approved plan change bills its proration
// =============================================================================
// createRequest stored proration_credit/charge/net, but approval only switched
// contracts.plan_id: no invoice for an upgrade's remaining days at the new
// price, no credit for a downgrade's unused days at the old one.

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

const db = require('../src/config/database');
const { mockTxConnection } = require('./fixtures/mockTxConnection');
const billingService = require('../src/services/billingService');
const creditNoteLedgerService = require('../src/services/creditNoteLedgerService');
const Organization = require('../src/models/Organization');
const businessEvents = require('../src/services/businessEvents');
const service = require('../src/services/portalServiceRequestService');

const REQUEST = {
  id: 31, organization_id: 4, client_id: 12, contract_id: 8, status: 'pending', request_type: 'plan_upgrade',
  payload: JSON.stringify({ new_plan_id: 3, new_plan_name: 'Fiber Pro', current_plan_id: 2, current_plan_name: 'Basic' }),
};

let conn;
function wire(request) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM portal_service_requests WHERE id = \? AND organization_id/.test(sql)) return [[request]];
    if (/FROM plans/.test(sql)) return [[{ id: 3, name: 'Fiber Pro', price: '599.00' }]];
    if (/SELECT \* FROM portal_service_requests WHERE id = \?/.test(sql)) return [[{ ...request, status: 'completed' }]];
    if (/^\s*INSERT INTO credit_notes/.test(sql)) return [{ insertId: 90, affectedRows: 1 }];
    if (/^\s*(UPDATE|INSERT)/.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
    return [[]];
  });
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  conn = mockTxConnection(db);
  jest.spyOn(billingService, 'createOneOffInvoice').mockResolvedValue({ id: 500, total: '58.00' });
  jest.spyOn(billingService, 'resolveTaxContext').mockResolvedValue({ rate: 0.16, taxRateId: 2 });
  jest.spyOn(creditNoteLedgerService, 'syncCreditNoteLedger').mockResolvedValue(undefined);
  jest.spyOn(Organization, 'getCurrency').mockResolvedValue('MXN');
  jest.spyOn(businessEvents, 'emitInvoiceCreated').mockResolvedValue(undefined);
});

test('an upgrade with a positive net raises a one-off invoice in the approval transaction', async () => {
  wire({ ...REQUEST, proration_net: '50.00' });
  await service.approveRequest(31, 4, 2, null);

  expect(billingService.createOneOffInvoice).toHaveBeenCalledWith(expect.objectContaining({
    orgId: 4, clientId: 12, contractId: 8, amount: 50, conn,
  }));
  expect(conn.execute.mock.calls.some(([sql]) => /UPDATE contracts SET plan_id/.test(sql))).toBe(true);
  expect(conn.commit).toHaveBeenCalledTimes(1);
  expect(businessEvents.emitInvoiceCreated).toHaveBeenCalledWith(4, expect.objectContaining({ id: 500 }));
});

test('a downgrade with a negative net issues a credit note and posts it to the ledger', async () => {
  wire({ ...REQUEST, proration_net: '-30.00' });
  await service.approveRequest(31, 4, 2, null);

  expect(billingService.createOneOffInvoice).not.toHaveBeenCalled();
  const insert = conn.execute.mock.calls.find(([sql]) => /INSERT INTO credit_notes/.test(sql));
  expect(insert[1]).toEqual(expect.arrayContaining([4, 12, 8, 'PCN-31', 30, 0.16, 4.8, 34.8, 'MXN']));
  expect(creditNoteLedgerService.syncCreditNoteLedger).toHaveBeenCalledWith(
    expect.any(Function), expect.objectContaining({ id: 90, total: 34.8, status: 'issued' }), 4,
  );
  expect(conn.commit).toHaveBeenCalledTimes(1);
});

test('a billing failure rolls back the plan change and the request stays pending', async () => {
  wire({ ...REQUEST, proration_net: '50.00' });
  billingService.createOneOffInvoice.mockRejectedValue(new Error('numbering sequence locked'));

  await expect(service.approveRequest(31, 4, 2, null)).rejects.toThrow(/numbering/);
  expect(conn.rollback).toHaveBeenCalled();
  expect(conn.commit).not.toHaveBeenCalled();
});

test('no proration (no invoiced period yet) changes the plan without billing', async () => {
  wire({ ...REQUEST, proration_net: null });
  await service.approveRequest(31, 4, 2, null);
  expect(billingService.createOneOffInvoice).not.toHaveBeenCalled();
  expect(conn.execute.mock.calls.some(([sql]) => /INSERT INTO credit_notes/.test(sql))).toBe(false);
  expect(conn.commit).toHaveBeenCalledTimes(1);
});

// The portal picks the target plan from this list instead of a typed id.
test('plan options are the org or global active plans, minus the current one', async () => {
  db.query.mockResolvedValueOnce([[{ id: 3, name: 'Fiber Pro' }]]);
  const plans = await service.listUpgradePlans(12, 4);

  expect(plans).toEqual([{ id: 3, name: 'Fiber Pro' }]);
  const [sql, params] = db.query.mock.calls[0];
  expect(sql).toMatch(/p\.organization_id <=> \? OR p\.organization_id IS NULL/);
  expect(sql).toMatch(/p\.status = 'active' AND p\.deleted_at IS NULL/);
  expect(sql).toMatch(/NOT IN \(\s*SELECT c\.plan_id FROM contracts c/);
  expect(params).toEqual([4, 12, 4]);
});
