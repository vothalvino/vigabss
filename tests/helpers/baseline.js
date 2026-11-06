'use strict';
// =============================================================================
// Read the install baseline (database/migrations/001_baseline.sql)
// =============================================================================
// The baseline is what an install applies: the whole schema, seed rows,
// routines, triggers and events. Tests that used to read the migration that
// introduced a table, a seed row or a trigger read it here instead.
// =============================================================================

const fs = require('fs');
const path = require('path');

const BASELINE = path.join(__dirname, '..', '..', 'database', 'migrations', '001_baseline.sql');
let cached;

function baselineSql() {
  if (cached === undefined) cached = fs.readFileSync(BASELINE, 'utf8');
  return cached;
}

/** The CREATE TABLE statement of `name`, through its closing `;`. */
function baselineTable(name) {
  const sql = baselineSql();
  const start = sql.indexOf(`CREATE TABLE \`${name}\` (`);
  if (start === -1) throw new Error(`baseline has no table ${name}`);
  return sql.slice(start, sql.indexOf(';\n', start) + 1);
}

/** Column definitions of a table, by name. */
function baselineColumns(name) {
  const columns = new Map();
  for (const m of baselineTable(name).matchAll(/^ {2}`(\w+)` ([^\n]*?),?$/gm)) columns.set(m[1], m[2]);
  return columns;
}

// One SQL literal from a dumped VALUES list.
function literal(token) {
  const t = token.trim();
  if (t === 'NULL') return null;
  if (t === 'NOW()') return 'NOW()';
  if (t.startsWith("'")) {
    return t.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', 0: '\0' }[c] ?? c)).replace(/''/g, "'");
  }
  if (/^0x[0-9a-f]+$/i.test(t)) return t;
  return Number.isNaN(Number(t)) ? t : Number(t);
}

function splitValues(s) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      cur += c;
      if (c === '\\') { cur += s[i + 1]; i += 1; } else if (c === "'") {
        if (s[i + 1] === "'") { cur += "'"; i += 1; } else quoted = false;
      }
    } else if (c === "'") { quoted = true; cur += c; } else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** The seed rows the baseline inserts into `table`, as objects. */
function baselineRows(table) {
  const rows = [];
  const re = new RegExp(`^INSERT INTO \`${table}\` \\((.*?)\\) VALUES \\((.*)\\);$`, 'gm');
  for (const m of baselineSql().matchAll(re)) {
    const columns = m[1].split(',').map(c => c.trim().replace(/`/g, ''));
    const values = splitValues(m[2]).map(literal);
    rows.push(Object.fromEntries(columns.map((c, i) => [c, values[i]])));
  }
  return rows;
}

/** The CREATE statement of a routine, trigger or event, through its END. */
function baselineProgram(kind, name) {
  const sql = baselineSql();
  const start = sql.indexOf(`CREATE ${kind.toUpperCase()} \`${name}\``);
  if (start === -1) throw new Error(`baseline has no ${kind} ${name}`);
  return sql.slice(start, sql.indexOf(' ;;\n', start) + 3);
}

module.exports = { BASELINE, baselineSql, baselineTable, baselineColumns, baselineRows, baselineProgram };
