'use strict';

// =============================================================================
// Lists filter by a date range and by the columns they allow
// =============================================================================
// ?date_from=&date_to= on a list whose model names a date column
// (BaseModel.dateFilter). Both days are included; a DATE column compares
// business days, a UTC DATETIME column compares the business days' own start
// and end. The same conditions drive the rows and the count.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), execute: jest.fn(), getConnection: jest.fn() }));

const db = require('../src/config/database');
const Invoice = require('../src/models/Invoice');
const Payment = require('../src/models/Payment');
const CfdiDocument = require('../src/models/CfdiDocument');
const CreditNote = require('../src/models/CreditNote');
const CashReconciliationSession = require('../src/models/CashReconciliationSession');
const Plan = require('../src/models/Plan');
const { businessDayStartUtc } = require('../src/utils/businessDate');

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue([[{ total: 0 }]]);
});

const lastCall = () => db.query.mock.calls.at(-1);

test('a DATE column: from the first day through the last day, with the client', async () => {
  await Invoice.findAll({ where: { client_id: '7', date_from: '2026-11-01', date_to: '2026-11-30' }, orgId: 1 });
  let [sql, params] = lastCall();
  expect(sql).toMatch(/`client_id` = \? AND `issue_date` >= \? AND `issue_date` < \?/);
  expect(params).toEqual([1, '7', '2026-11-01', '2026-12-01']);

  await Invoice.count({ where: { client_id: '7', date_from: '2026-11-01', date_to: '2026-11-30' }, orgId: 1 });
  [sql, params] = lastCall();
  expect(sql).toMatch(/COUNT\(\*\)/);
  expect(sql).toMatch(/`issue_date` >= \? AND `issue_date` < \?/);
  expect(params).toEqual([1, '7', '2026-11-01', '2026-12-01']);
});

test('one end alone works, and each list uses its own date', async () => {
  await Payment.findAll({ where: { date_from: '2026-11-15' }, orgId: 1 });
  expect(lastCall()[0]).toMatch(/`payment_date` >= \?/);
  expect(lastCall()[0]).not.toMatch(/`payment_date` < \?/);
  await CreditNote.findAll({ where: { date_to: '2026-12-31' }, orgId: 1 });
  expect(lastCall()[0]).toMatch(/`issue_date` < \?/);
  expect(lastCall()[1]).toEqual([1, '2027-01-01']);
});

test('a UTC DATETIME column is compared with the business days\' start and end', async () => {
  await CfdiDocument.findAll({ where: { date_from: '2026-11-01', date_to: '2026-11-01' }, orgId: 1 });
  const [sql, params] = lastCall();
  expect(sql).toMatch(/`created_at` >= \? AND `created_at` < \?/);
  expect(params.slice(1)).toEqual([businessDayStartUtc('2026-11-01'), businessDayStartUtc('2026-11-02')]);
  await CashReconciliationSession.findAll({ where: { date_from: '2026-11-01' }, orgId: 1 });
  expect(lastCall()[0]).toMatch(/`opened_at` >= \?/);
});

test('a value that is not a date is refused; an empty one is ignored', async () => {
  await expect(Invoice.findAll({ where: { date_from: '11/01/2026' }, orgId: 1 })).rejects.toMatchObject({ statusCode: 422 });
  await expect(Invoice.count({ where: { date_to: '2026-13-45' }, orgId: 1 })).rejects.toMatchObject({ statusCode: 422 });
  await expect(Invoice.findAll({ where: { date_from: ['2026-11-01', '2026-11-02'] }, orgId: 1 })).rejects.toMatchObject({ statusCode: 422 });
  await Invoice.findAll({ where: { date_from: '', date_to: '' }, orgId: 1 });
  expect(lastCall()[0]).not.toMatch(/issue_date/);
});

test('a list with no date column ignores the range, and it is never treated as a column', async () => {
  await Plan.findAll({ where: { date_from: '2026-11-01', date_to: 'nonsense' }, orgId: 1 });
  const [sql] = lastCall();
  expect(sql).not.toMatch(/date_from|date_to|>= \?/);
});
