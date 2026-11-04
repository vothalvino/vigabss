'use strict';
// =============================================================================
// FE-23 — billing, ticket and contract reads are typed from schema.sql
// =============================================================================
// Their responses were documented as a bare { type: 'object' }, so every page
// cast the body (`res.data as unknown as InvoicesResponse`) to a local
// interface restating the columns, and nothing checked the two agreed. The
// spec now builds each row schema from database/schema.sql.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { tableRowSchema, columnSchema } = require('../src/utils/tableRowSchema');
const { parseSchema } = require('../src/scripts/sql-column-check');
const spec = require('../docs/openapi.json');

const schemaSql = parseSchema(fs.readFileSync(path.resolve(__dirname, '../database/schema.sql'), 'utf8'));

test('columns map to their JSON wire types', () => {
  expect(columnSchema('BIGINT UNSIGNED NOT NULL AUTO_INCREMENT')).toEqual({ type: 'integer' });
  expect(columnSchema('TINYINT(1) NOT NULL DEFAULT 0')).toEqual({ type: 'integer' });
  // mysql2 sends DECIMAL as a string.
  expect(columnSchema('DECIMAL(10,2) NOT NULL')).toEqual({ type: 'string', format: 'decimal' });
  expect(columnSchema('DATE NULL')).toEqual({ type: ['string', 'null'], format: 'date-time' });
  expect(columnSchema("ENUM('open','closed') NOT NULL DEFAULT 'open'")).toEqual({ type: 'string', enum: ['open', 'closed'] });
  expect(columnSchema("ENUM('a','b') NULL")).toEqual({ type: ['string', 'null'], enum: ['a', 'b', null] });
  expect(columnSchema('JSON NULL')).toEqual({});
  expect(columnSchema('VARCHAR(255) NULL')).toEqual({ type: ['string', 'null'] });
});

test.each(['invoices', 'invoice_items', 'payments', 'payment_allocations', 'credit_notes', 'tickets', 'contracts'])(
  '%s: every schema.sql column, all required',
  (table) => {
    const row = tableRowSchema(table);
    expect(Object.keys(row.properties).sort()).toEqual([...schemaSql.get(table).columns].sort());
    expect(row.required.sort()).toEqual(Object.keys(row.properties).sort());
    expect(row.additionalProperties).toBe(true);
  },
);

test.each([
  ['/invoices', 'Invoice'], ['/payments', 'Payment'], ['/credit-notes', 'CreditNote'],
  ['/tickets', 'Ticket'], ['/contracts', 'Contract'],
])('GET %s and its {id} read answer with typed %s rows', (base, component) => {
  const json = op => op.responses[200].content['application/json'].schema;
  const list = json(spec.paths[base].get);
  expect(list.properties.data.items).toEqual({ $ref: `#/components/schemas/${component}` });
  expect(list.properties.meta.required).toEqual(['total', 'page', 'limit', 'totalPages']);
  expect(json(spec.paths[`${base}/{id}`].get).properties.data).toEqual({ $ref: `#/components/schemas/${component}` });
  expect(spec.components.schemas[component].properties.id).toEqual({ type: 'integer' });
});

test('invoice items and applied payments answer with typed rows', () => {
  const items = spec.paths['/invoices/{id}/items'].get.responses[200].content['application/json'].schema;
  expect(items.properties.data.items).toEqual({ $ref: '#/components/schemas/InvoiceItem' });
  const payments = spec.paths['/invoices/{id}/payments'].get.responses[200].content['application/json'].schema;
  expect(payments.properties.data.items).toEqual({ $ref: '#/components/schemas/PaymentAllocation' });
  expect(spec.components.schemas.PaymentAllocation.properties.payment_amount).toEqual({ type: 'string', format: 'decimal' });
});
