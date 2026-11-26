'use strict';

// An invoice covered by a payment and a credit note is paid when their cents
// add up to its total. Added as floats, 346.84 + 232.00 is 578.8399999999999,
// which is under 578.84: such an invoice stayed unpaid.

jest.mock('../src/config/database', () => ({ query: jest.fn(), execute: jest.fn(), getConnection: jest.fn() }));
jest.mock('../src/services/resellerCommissionService', () => ({ syncCommissionByInvoice: jest.fn().mockResolvedValue(undefined) }));

const { finalizeIfFullyPaid } = require('../src/services/paymentAllocationService');

function execWith(paid, credited) {
  const updates = [];
  const exec = jest.fn(async (sql, params) => {
    if (/SELECT SUM\(amount\) AS total_allocated/.test(sql)) return [[{ total_allocated: paid }, { total_allocated: credited }]];
    updates.push([sql, params]);
    return [{ affectedRows: 1 }];
  });
  return { exec, updates };
}

test('a payment plus a credit note that add up to the total mark the invoice paid', async () => {
  expect(346.84 + 232 < 578.84).toBe(true); // the float trap this guards against
  const { exec, updates } = execWith('346.84', '232.00');
  expect(await finalizeIfFullyPaid(exec, { id: 51, total: '578.84', organization_id: 1 })).toBe(true);
  expect(updates[0][0]).toMatch(/UPDATE invoices SET status = \?, paid_at = NOW\(\)/);
  expect(updates[0][1]).toEqual(['paid', 51]);
});

test('one cent short is still unpaid, and nothing applied is unpaid', async () => {
  let { exec, updates } = execWith('346.83', '232.00');
  expect(await finalizeIfFullyPaid(exec, { id: 51, total: '578.84' })).toBe(false);
  expect(updates).toHaveLength(0);
  ({ exec, updates } = execWith(null, null));
  expect(await finalizeIfFullyPaid(exec, { id: 51, total: '578.84' })).toBe(false);
  expect(updates).toHaveLength(0);
});
