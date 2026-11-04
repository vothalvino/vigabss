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
// virtual key below.
// =============================================================================

const { mapSchemas, loadTables } = require('./helpers/validatorSchemaMap');
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
  'security.js:updatePasswordPolicy.require_symbols': 'legacy alias of require_special_chars',
  'settings.js:updateSetting.value': 'written as setting_value',
  'sniiReporting.js:setApplicability.status': 'written as applicability',
  'users.js:createUser.organization_ids': 'written to organization_users',
  'users.js:updateUser.organization_ids': 'written to organization_users',
  'users.js:patchUser.organization_ids': 'written to organization_users',
};

const SEALED = ['_encrypted', '_enc', '_hash'];

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

// A schema with no table is an action (login, stamp, merge, …), not a row.
// A new one must be added to tests/fixtures/validatorActionSchemas.json, or
// mapped (TABLE_OVERRIDES in tests/helpers/validatorSchemaMap.js).
test('every schema maps to a table or is a reviewed action schema', () => {
  expect(unmapped.filter(id => !actionSchemas.includes(id))).toEqual([]);
  expect(actionSchemas.filter(id => !unmapped.includes(id))).toEqual([]);
  expect(mapped.length).toBeGreaterThan(300);
});
