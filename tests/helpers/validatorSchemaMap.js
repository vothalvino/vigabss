'use strict';
// =============================================================================
// Validator schema → the table it writes (FE2-13)
// =============================================================================
// Maps each exported schema in src/middleware/schemas to a table in
// database/schema.sql: an explicit override, else the table named after the
// schema (createPayment → payments) or its file, else the table whose columns
// cover most of the schema's keys. A schema that maps to nothing is returned
// as unmapped for the caller to account for.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { parseSchema } = require('../../src/scripts/sql-column-check');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA_DIR = path.join(ROOT, 'src', 'middleware', 'schemas');
const VERB = /^(create|update|patch|bulk|add|edit|set|upsert|replace)(?=[A-Z_])/;

// Where the name and the columns point at the wrong table.
const TABLE_OVERRIDES = {
  'numberingManagement.js:createPortability': 'number_portability_records',
  'numberingManagement.js:updatePortability': 'number_portability_records',
  'plans.js:createSpeedWindow': 'plan_speed_windows',
  'plans.js:createAccessWindow': 'plan_access_windows',
};

const snake = s => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
function plurals(w) {
  const out = [`${w}s`, w];
  if (w.endsWith('y')) out.push(`${w.slice(0, -1)}ies`);
  if (/(s|x|ch|sh)$/.test(w)) out.push(`${w}es`);
  return out;
}

function fieldsOf(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  return Object.keys(schema).filter(k => schema[k] && typeof schema[k] === 'object' && 'type' in schema[k]);
}

function loadTables() {
  return parseSchema(fs.readFileSync(path.join(ROOT, 'database', 'schema.sql'), 'utf8'));
}

function mapSchemas(tables = loadTables()) {
  const mapped = [];
  const unmapped = [];
  for (const file of fs.readdirSync(SCHEMA_DIR).filter(f => f.endsWith('.js')).sort()) {
    const mod = require(path.join(SCHEMA_DIR, file));
    for (const [name, schema] of Object.entries(mod)) {
      const keys = fieldsOf(schema);
      if (!keys.length) continue;
      const id = `${file}:${name}`;
      const overlap = t => keys.filter(k => tables.get(t).columns.has(k)).length;
      let table = TABLE_OVERRIDES[id];
      if (!table) {
        const base = snake(name.replace(VERB, '')).replace(/^_/, '');
        const fileBase = snake(file.replace(/\.js$/, ''));
        table = [...plurals(base), ...plurals(fileBase), ...plurals(`${fileBase.replace(/s$/, '')}_${base}`)]
          .filter(t => tables.has(t))
          .find(t => overlap(t) >= Math.max(1, keys.length / 2));
      }
      if (!table) {
        let best = 0;
        for (const t of tables.keys()) {
          const o = overlap(t);
          if (o >= 2 && o / keys.length >= 0.75 && o > best) { best = o; table = t; }
        }
      }
      if (table) mapped.push({ id, name, schema, keys, table, write: VERB.test(name) });
      else unmapped.push(id);
    }
  }
  return { mapped, unmapped };
}

module.exports = { mapSchemas, loadTables, fieldsOf, TABLE_OVERRIDES };
