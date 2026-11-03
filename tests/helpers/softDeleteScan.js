'use strict';
// =============================================================================
// Raw SQL that reads a soft-delete table without a deleted_at condition (DAL-14)
// =============================================================================
// BaseModel adds `deleted_at IS NULL` for softDelete models, but hand-written
// SQL has to do it itself. This finds every FROM/JOIN of a softDelete model's
// table inside a SQL string literal in src/routes and src/services whose
// statement never mentions that table's (or its alias's) deleted_at.
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function softDeleteTables() {
  const dir = path.join(ROOT, 'src', 'models');
  const tables = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js') || f === 'BaseModel.js') continue;
    const M = require(path.join(dir, f));
    if (typeof M === 'function' && typeof M.tableName === 'string' && M.softDelete) tables.add(M.tableName);
  }
  return tables;
}

// SQL-looking string literals ('...', "...", `...`).
function sqlLiterals(src) {
  const out = [];
  const re = /(`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g;
  let m;
  while ((m = re.exec(src))) {
    const text = m[1].slice(1, -1);
    // A reviewed read that wants deleted rows says so in the SQL itself:
    // /* includes deleted rows: <reason> */
    if (/includes deleted rows:/i.test(text)) continue;
    if (/\b(SELECT|UPDATE|DELETE)\b/i.test(text) && /\b(FROM|JOIN)\b/i.test(text)) out.push(text);
  }
  return out;
}

const KEYWORDS = new Set(['where', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'on', 'using', 'group', 'order', 'limit', 'set', 'for', 'union', 'having', 'as', 'straight_join']);

function unfilteredReads(text, tables) {
  const found = [];
  const re = /\b(?:FROM|JOIN)\s+`?([a-z_][a-z0-9_]*)`?(?:\s+(?:AS\s+)?`?([a-z_][a-z0-9_]*)`?)?/gi;
  let m;
  while ((m = re.exec(text))) {
    const table = m[1].toLowerCase();
    if (!tables.has(table)) continue;
    const alias = m[2] && !KEYWORDS.has(m[2].toLowerCase()) ? m[2] : table;
    const qualified = new RegExp(`\\b${alias}\\.\`?deleted_at\\b`, 'i');
    // An unaliased single-table statement may say just deleted_at.
    const bare = alias === table && /(?<![.\w])`?deleted_at\b/i.test(text);
    if (!qualified.test(text) && !bare) found.push(table);
  }
  return found;
}

function scan() {
  const tables = softDeleteTables();
  const counts = {};
  for (const dir of ['src/routes', 'src/services']) {
    const walk = (d) => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        const src = fs.readFileSync(p, 'utf8');
        let n = 0;
        for (const lit of sqlLiterals(src)) n += unfilteredReads(lit, tables).length;
        if (n) counts[path.relative(ROOT, p)] = n;
      }
    };
    walk(path.join(ROOT, dir));
  }
  return counts;
}

module.exports = { scan, unfilteredReads, softDeleteTables };
