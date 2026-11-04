// =============================================================================
// VigaBSS 5.0 — OpenAPI row schemas from database/schema.sql (FE-23)
// =============================================================================
// A route that answers with `SELECT * FROM <table>` rows sends the table's
// columns as mysql2 serializes them. Typing those responses by hand would
// drift from the table; this reads the CREATE TABLE (and the ALTER ... ADD
// blocks that mirror later migrations) and maps each column to its JSON wire
// type:
//   - integer types, TINYINT(1) included              → integer
//   - DECIMAL/NUMERIC (mysql2 sends them as strings)  → string, format decimal
//   - FLOAT/DOUBLE                                    → number
//   - DATE/DATETIME/TIMESTAMP (Date → JSON)           → string, format date-time
//   - ENUM                                            → string enum
//   - JSON                                            → any value
//   - everything else                                 → string
// A NULL-able column also allows null. Every column is required: use this only
// for a response that sends whole rows (SELECT * or t.*), where a NULL column
// is null, not absent. Extra properties are allowed (joined fields).
// =============================================================================

const fs = require('fs');
const path = require('path');
const {
  stripSqlComments, readBalanced, splitTopLevel, parseEnumValues, NON_COLUMN_KEYWORDS,
} = require('../scripts/sql-column-check');

const SCHEMA_SQL = path.resolve(__dirname, '../../database/schema.sql');

let tables = null;

/** column name → its definition text after the name, per table. */
function columnDefinitions() {
  if (tables) return tables;
  const sql = stripSqlComments(fs.readFileSync(SCHEMA_SQL, 'utf8'));
  tables = new Map();
  const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?\s*\(/gi;
  let m;
  while ((m = create.exec(sql))) {
    const bal = readBalanced(sql, m.index + m[0].length - 1);
    if (!bal) continue;
    const columns = new Map();
    for (const raw of splitTopLevel(bal.body)) {
      const def = raw.trim();
      const name = /^[`"]?(\w+)[`"]?\s+([\s\S]*)$/.exec(def);
      if (!def || NON_COLUMN_KEYWORDS.test(def) || !name) continue;
      columns.set(name[1].toLowerCase(), name[2]);
    }
    tables.set(m[1].toLowerCase(), columns);
    create.lastIndex = bal.end;
  }
  const alterAdd = /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?\s+([^;]*?)(?:,\s*ADD\b|;|$)/gi;
  while ((m = alterAdd.exec(sql))) {
    const columns = tables.get(m[1].toLowerCase());
    const col = m[2].toLowerCase();
    if (columns && !NON_COLUMN_KEYWORDS.test(col) && !columns.has(col)) columns.set(col, m[3]);
  }
  return tables;
}

/** The OpenAPI schema of one column's JSON value. */
function columnSchema(def) {
  const type = (/^(\w+)/.exec(def) || [])[1].toUpperCase();
  let schema;
  if (/^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|BOOL|BOOLEAN|BIT|YEAR)$/.test(type)) schema = { type: 'integer' };
  else if (/^(DECIMAL|NUMERIC|DEC|FIXED)$/.test(type)) schema = { type: 'string', format: 'decimal' };
  else if (/^(FLOAT|DOUBLE|REAL)$/.test(type)) schema = { type: 'number' };
  else if (/^(DATE|DATETIME|TIMESTAMP)$/.test(type)) schema = { type: 'string', format: 'date-time' };
  else if (type === 'ENUM') schema = { type: 'string', enum: [...parseEnumValues(def)] };
  else if (type === 'JSON') return {};
  else schema = { type: 'string' };
  if (!/\bNOT\s+NULL\b/i.test(def)) {
    schema.type = [schema.type, 'null'];
    if (schema.enum) schema.enum.push(null);
  }
  return schema;
}

/**
 * The row schema of a table, for a component in the OpenAPI spec.
 * @param {string} table  table name in database/schema.sql
 * @param {string} [description]
 */
function tableRowSchema(table, description) {
  const columns = columnDefinitions().get(table);
  if (!columns) throw new Error(`tableRowSchema: no table ${table} in database/schema.sql`);
  const properties = {};
  for (const [name, def] of columns) properties[name] = columnSchema(def);
  return {
    type: 'object',
    description: description || `A ${table} row (columns from database/schema.sql)`,
    properties,
    required: Object.keys(properties),
    additionalProperties: true,
  };
}

module.exports = { tableRowSchema, columnSchema };
