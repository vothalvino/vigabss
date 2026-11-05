'use strict';
// =============================================================================
// FE2-13 — validator schemas agree with the columns they write
// =============================================================================
// sql:check reads literal SQL, so a value bound into a dynamic INSERT is
// invisible to it, and nothing compared the validators with schema.sql. The
// scheduled-task form offered five task types the scheduled_tasks.task_type
// ENUM does not have, so creating one failed in MySQL with a 500; the speed
// test job update accepted 'pending' for a column whose value is 'queued'.
// Here every enum value a validator accepts must be in the target column's
// ENUM, and every key of a create/update schema must be a column of its
// table, a secret sealed into <key>_encrypted/_enc/_hash, or a reviewed
// virtual key below. A create schema must also require every NOT NULL column
// without a default, or the handler must fill it (SERVER_FILLED): an expense
// without expense_date, a 6rd tunnel without its border relay and a firewall
// rule without a name all failed the INSERT with a 500.
// =============================================================================

const { mapSchemas, loadTables, requiredColumns } = require('./helpers/validatorSchemaMap');
const actionSchemas = require('./fixtures/validatorActionSchemas.json');

const tables = loadTables();
const { mapped, unmapped } = mapSchemas(tables);

// Keys of a write schema that are not a column of its table, and what the
// handler does with them.
const VIRTUAL = {
  'clients.js:createContact.name': 'split into first_name and last_name',
  'contracts.js:updateContract.prorate': 'with a plan change: bill the rest of the invoiced period (planChangeProrationService)',
  'contracts.js:patchContract.prorate': 'with a plan change: bill the rest of the invoiced period (planChangeProrationService)',
  'creditNotes.js:createCreditNoteItem.amount': 'checked against quantity × unit_price; total is computed',
  'quotes.js:createQuoteItem.amount': 'checked against quantity × unit_price; total is computed',
  'dataPacks.js:createDataPack.status': 'written as is_active',
  'dataPacks.js:updateDataPack.status': 'written as is_active',
  'inventory.js:createInventoryTransaction.item_id': 'resolves the stock row (stock_id) for an adjustment',
  'inventory.js:createInventoryTransaction.warehouse_id': 'resolves the stock row (stock_id) for an adjustment',
  'paymentPlans.js:createPaymentPlan.invoice_id': 'links the installments to the invoice',
  'plans.js:createPlanAddon.taxable': 'written as is_taxable',
  'settings.js:updateSetting.value': 'written as setting_value',
  'sniiReporting.js:setApplicability.status': 'written as applicability',
  'users.js:createUser.organization_ids': 'written to organization_users',
  'users.js:updateUser.organization_ids': 'written to organization_users',
  'users.js:patchUser.organization_ids': 'written to organization_users',
};

const SEALED = ['_encrypted', '_enc', '_hash'];

// NOT NULL columns without a default that a create schema does not require,
// because the handler fills them.
const PATH_PARENT = 'the parent id from the path';
const SERVER_FILLED = {
  'alertEscalations.js:createStep.chain_id': PATH_PARENT,
  'apiTokens.js:createApiToken.user_id': 'the signed-in user',
  'apiTokens.js:createApiToken.token_hash': 'hash of the generated token',
  'clients.js:createContact.client_id': PATH_PARENT,
  'clients.js:createContact.first_name': 'split from the required name',
  'clients.js:createContact.last_name': 'split from the required name',
  'contracts.js:createContractAddon.contract_id': PATH_PARENT,
  'contracts.js:createContractAddon.unit_price': "the catalog add-on's price when omitted",
  'contracts.js:createContractAddon.start_date': 'today when omitted',
  'coverageZones.js:createCoverageZone.service_area_id': 'required and ownership-checked by coverageZoneService.createZone (the route does not use this schema)',
  'coverageZones.js:createCoverageZone.boundary': 'a GeoJSON polygon checked by coverageZoneService.createZone',
  'cpeParameterMappings.js:createCpeParameterMapping.cpe_profile_id': PATH_PARENT,
  'cpeTasks.js:createCpeTask.cpe_device_id': PATH_PARENT,
  'creditNotes.js:createCreditNote.credit_note_number': 'the next NC-###### number when omitted (billingService.nextCreditNoteNumber)',
  'creditNotes.js:createCreditNoteItem.credit_note_id': PATH_PARENT,
  'expenses.js:createExpense.user_id': 'the signed-in staff member',
  'inventory.js:createInventoryTransaction.stock_id': 'resolved from item_id and warehouse_id',
  'invoices.js:createInvoice.invoice_number': 'the next INV-###### number when omitted',
  'nas.js:createNas.ip_address': 'required for a direct NAS; the tunnel address for a NATed one',
  'paymentGateways.js:createPaymentGateway.secret_key_encrypted': "sealed from secret_key; '' for a gateway without one",
  'plans.js:createSpeedWindow.plan_id': PATH_PARENT,
  'plans.js:createAccessWindow.plan_id': PATH_PARENT,
  'purchaseOrders.js:createPoItem.po_id': PATH_PARENT,
  'quotes.js:createQuote.quote_number': 'the next QUO-###### number when omitted',
  'quotes.js:createQuoteItem.quote_id': PATH_PARENT,
  'radius.js:createRoute.radius_account_id': PATH_PARENT,
  'serviceOrders.js:createServiceOrder.order_number': 'the next order number',
  'serviceOrders.js:createServiceOrderTask.service_order_id': PATH_PARENT,
  'snmpProfiles.js:createSnmpProfileOid.profile_id': PATH_PARENT,
  'tickets.js:createComment.ticket_id': PATH_PARENT,
  'users.js:createUser.password_hash': 'hash of the required password',
};
// Batches and filing events are built by sniiReportingService from the
// catalog and the uploaded evidence, not from body fields.
const SERVER_BUILT = new Set(['sniiReporting.js:createBatch', 'sniiReporting.js:createFilingEvent']);

test('every validator enum value is a value of the column it is written to', () => {
  const bad = [];
  for (const m of mapped) {
    const enums = tables.get(m.table).enums;
    for (const key of m.keys) {
      const allowed = m.schema[key].enum;
      const column = enums.get(key);
      if (!allowed || !column) continue;
      const extra = allowed.filter(v => v !== null && !column.has(String(v)));
      if (extra.length) bad.push(`${m.id}.${key} → ${m.table}.${key}: ${extra.join(', ')}`);
    }
  }
  expect(bad).toEqual([]);
});

test('every key of a create/update schema is a column, a sealed secret, or a reviewed virtual key', () => {
  const unknown = [];
  for (const m of mapped.filter(x => x.write)) {
    const { columns } = tables.get(m.table);
    for (const key of m.keys) {
      if (columns.has(key) || SEALED.some(s => columns.has(key + s)) || VIRTUAL[`${m.id}.${key}`]) continue;
      unknown.push(`${m.id}.${key} (${m.table})`);
    }
  }
  expect(unknown).toEqual([]);
});

test('the virtual-key list has no stale entries', () => {
  const live = new Set();
  for (const m of mapped.filter(x => x.write)) for (const key of m.keys) live.add(`${m.id}.${key}`);
  expect(Object.keys(VIRTUAL).filter(k => !live.has(k))).toEqual([]);
});

test('a create schema requires every NOT NULL column without a default, or the handler fills it', () => {
  const required = requiredColumns();
  const missing = [];
  for (const m of mapped.filter(x => /^create/.test(x.name) && !SERVER_BUILT.has(x.id))) {
    for (const column of required.get(m.table) || []) {
      if (column === 'organization_id' || m.schema[column]?.required || SERVER_FILLED[`${m.id}.${column}`]) continue;
      missing.push(`${m.id}.${column} (${m.table})`);
    }
  }
  expect(missing).toEqual([]);
});

test('the server-filled list has no stale entries', () => {
  const required = requiredColumns();
  const live = new Set();
  for (const m of mapped) for (const column of required.get(m.table) || []) if (!m.schema[column]?.required) live.add(`${m.id}.${column}`);
  expect(Object.keys(SERVER_FILLED).filter(k => !live.has(k))).toEqual([]);
});

// A schema with no table is an action (login, stamp, merge, …), not a row.
// A new one must be added to tests/fixtures/validatorActionSchemas.json, or
// mapped (TABLE_OVERRIDES in tests/helpers/validatorSchemaMap.js).
test('every schema maps to a table or is a reviewed action schema', () => {
  expect(unmapped.filter(id => !actionSchemas.includes(id))).toEqual([]);
  expect(actionSchemas.filter(id => !unmapped.includes(id))).toEqual([]);
  expect(mapped.length).toBeGreaterThan(300);
});
