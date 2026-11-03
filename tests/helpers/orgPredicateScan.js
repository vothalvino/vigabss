'use strict';
// =============================================================================
// Raw SQL that selects tenant rows by id without an organization predicate
// (TNA-37)
// =============================================================================
// A statement like `SELECT * FROM invoices WHERE client_id = ?` returns
// another organization's rows when the id came from the request and nothing
// checked its owner first. This finds every SELECT/UPDATE/DELETE string
// literal in src/routes and src/services that reads or writes a table with an
// organization_id column, filters it by an id (`id = ?`, `x_id = ?`,
// `id IN (…)`), and never mentions organization_id. Many are safe because the
// handler checked the parent first; a reviewed one says so in the SQL:
//   /* org-scoped by: <reason> */
// =============================================================================

const fs = require('fs');
const path = require('path');
const { sqlLiterals } = require('./softDeleteScan');

const ROOT = path.join(__dirname, '..', '..');

function orgTables() {
  const schema = fs.readFileSync(path.join(ROOT, 'database', 'schema.sql'), 'utf8');
  const tables = new Set();
  const re = /CREATE TABLE IF NOT EXISTS `?(\w+)`?\s*\(([\s\S]*?)\n\)\s*ENGINE/g;
  let m;
  while ((m = re.exec(schema))) {
    if (/^\s*`?organization_id`?\s/m.test(m[2])) tables.add(m[1].toLowerCase());
  }
  return tables;
}

const BY_ID = /\bWHERE\b[\s\S]*?(?<![\w.])(?:\w+\.)?`?(?:id|\w+_id)`?\s*(?:=\s*\?|IN\s*\()/i;

function unscopedStatement(text, tables) {
  if (/org-scoped by:/i.test(text)) return null;
  if (!/^\s*(?:\/\*[\s\S]*?\*\/\s*)?(SELECT|UPDATE|DELETE|WITH)\b/i.test(text)) return null;
  if (/organization_id|org_dedup/i.test(text)) return null;
  if (!BY_ID.test(text)) return null;
  const re = /\b(?:FROM|JOIN|UPDATE)\s+`?([a-z_][a-z0-9_]*)`?/gi;
  let m;
  while ((m = re.exec(text))) {
    if (tables.has(m[1].toLowerCase())) return m[1].toLowerCase();
  }
  return null;
}

function scan() {
  const tables = orgTables();
  const counts = {};
  for (const dir of ['src/routes', 'src/services']) {
    const walk = (d) => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        const src = fs.readFileSync(p, 'utf8');
        let n = 0;
        for (const lit of sqlLiterals(src, { keepDeletedRows: true })) if (unscopedStatement(lit, tables)) n++;
        if (n) counts[path.relative(ROOT, p)] = n;
      }
    };
    walk(path.join(ROOT, dir));
  }
  return counts;
}

module.exports = { scan, unscopedStatement, orgTables };
