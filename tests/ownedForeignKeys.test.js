'use strict';
// =============================================================================
// TNA-38 — generic CRUD checks every foreign key it writes
// =============================================================================
// Ownership of referenced rows was checked by hand, route by route, and some
// paths skipped it (PUT /cfdi-documents/:id let client_id, invoice_id and
// payment_id through). crudController now checks each foreign key a create or
// update writes against the caller's organization, from the FOREIGN KEY
// constraints in schema.sql, after the route's own hooks.
// =============================================================================

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({ query: (...a) => mockQuery(...a), getConnection: jest.fn() }));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const fs = require('fs');
const { generate, OUT } = require('../src/scripts/generate-owned-fks');
const { crudController } = require('../src/controllers/crudController');
const BaseModel = require('../src/models/BaseModel');

class CfdiDocument extends BaseModel {
  static get tableName() { return 'cfdi_documents'; }
  static get fillable() { return ['organization_id', 'client_id', 'invoice_id', 'payment_id', 'tipo']; }
  static get hasOrgScope() { return true; }
}

function run(handler, req) {
  return new Promise((resolve) => {
    const res = { status: jest.fn(() => res), json: jest.fn(body => resolve({ status: res.status.mock.calls.at(-1)?.[0] ?? 200, body })), send: jest.fn() };
    handler(req, res, err => resolve({ error: err }));
  });
}

beforeEach(() => mockQuery.mockReset());

test('the committed map matches schema.sql', () => {
  expect(JSON.parse(fs.readFileSync(OUT, 'utf8'))).toEqual(generate());
  expect(generate().cfdi_documents).toEqual({ client_id: 'clients', invoice_id: 'invoices', payment_id: 'payments' });
});

test('an update that points a document at another organization\'s invoice is refused', async () => {
  mockQuery.mockImplementation(async (sql) => {
    if (/FROM `cfdi_documents` WHERE id = \?/.test(sql)) return [[{ id: 9, organization_id: 1 }]];
    if (/SELECT id FROM invoices/.test(sql)) return [[]]; // not in org 1
    return [{ affectedRows: 1 }];
  });
  const ctrl = crudController(CfdiDocument);

  const { error } = await run(ctrl.update, { params: { id: 9 }, body: { invoice_id: 777 }, orgId: 1, user: { id: 2 } });

  expect(error).toMatchObject({ statusCode: 422, message: 'invoice_id does not belong to this organization' });
  expect(mockQuery.mock.calls.some(([sql]) => /^UPDATE/.test(sql))).toBe(false);
});

test('a create checks the references it writes; own rows pass', async () => {
  mockQuery.mockImplementation(async (sql) => {
    if (/SELECT id FROM clients/.test(sql)) return [[{ id: 5 }]];
    if (/^INSERT/.test(sql)) return [{ insertId: 3 }];
    if (/FROM `cfdi_documents`/.test(sql)) return [[{ id: 3, client_id: 5 }]];
    return [{ affectedRows: 1 }];
  });
  const ctrl = crudController(CfdiDocument);

  const result = await run(ctrl.create, { body: { client_id: 5, tipo: 'I' }, orgId: 1, user: { id: 2 } });

  expect(result.error).toBeUndefined();
  const check = mockQuery.mock.calls.find(([sql]) => /SELECT id FROM clients/.test(sql));
  expect(check[0]).toMatch(/organization_id <=> \?/);
  expect(check[1]).toEqual([5, 1]);
});

test('the route\'s own hook runs first, and a null ownedRefs entry turns a default off', async () => {
  const order = [];
  mockQuery.mockImplementation(async (sql) => {
    if (/SELECT id FROM/.test(sql)) order.push(sql.match(/FROM (\w+)/)[1]);
    if (/SELECT id FROM/.test(sql)) return [[]];
    return [[{ id: 9 }]];
  });
  const ctrl = crudController(CfdiDocument, {
    ownedRefs: { invoice_id: null },
    beforeUpdate: async () => { order.push('hook'); },
  });

  const { error } = await run(ctrl.update, { params: { id: 9 }, body: { invoice_id: 777, client_id: 4 }, orgId: 1, user: { id: 2 } });

  expect(order).toEqual(['hook', 'clients']);
  expect(error.message).toBe('client_id does not belong to this organization');
});
