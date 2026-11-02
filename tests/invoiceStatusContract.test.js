// =============================================================================
// BIL-27 — an invoice's status is not a free field
// =============================================================================
// POST /invoices accepted paid, overdue, cancelled and void at creation, and
// PUT/PATCH accepted paid and overdue: a "paid" invoice with no allocation, or
// a stored "overdue" that nothing else writes (overdue is derived from
// due_date). 'paid' follows payment allocation; 'cancelled' follows SAT.

const { validate } = require('../src/middleware/validate');
const { createInvoice, updateInvoice, patchInvoice } = require('../src/middleware/schemas/invoices');

function run(schema, body) {
  let err;
  validate(schema)({ body }, {}, (e) => { err = e; });
  return err;
}

const base = { client_id: 1, subtotal: 100, total: 116, due_date: '2026-12-01' };

test.each(['paid', 'overdue', 'cancelled', 'void'])('POST refuses status %s', (status) => {
  expect(run(createInvoice, { ...base, status })).toMatchObject({ statusCode: 422 });
});

test.each(['draft', 'issued'])('POST accepts status %s', (status) => {
  expect(run(createInvoice, { ...base, status })).toBeUndefined();
});

test.each([
  ['PUT', updateInvoice],
  ['PATCH', patchInvoice],
])('%s refuses paid and overdue', (_m, schema) => {
  expect(run(schema, { status: 'paid' })).toMatchObject({ statusCode: 422 });
  expect(run(schema, { status: 'overdue' })).toMatchObject({ statusCode: 422 });
  expect(run(schema, { status: 'issued' })).toBeUndefined();
});
