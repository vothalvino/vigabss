// =============================================================================
// Every table declares its collation
// =============================================================================
// A CREATE TABLE without COLLATE= takes the server's default: utf8mb4_0900_ai_ci
// on MySQL 8.4, utf8mb4_general_ci on MariaDB. ticket_attachments and
// work_order_attachments did, so their text columns differed from every other
// table's utf8mb4_unicode_ci and comparing them across tables could fail with
// "Illegal mix of collations". Found by dumping a migrated database on both
// engines.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migrationsDir = path.join(root, 'database/migrations');

// Comments and quoted strings are blanked first, so parentheses or SQL inside
// them neither end a table body nor look like a CREATE TABLE.
function stripCommentsAndStrings(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*|'(?:[^'\\]|\\.|'')*'/g, m => m.replace(/[^\n]/g, ' '));
}

// [table, table options] for each CREATE TABLE.
function createTables(rawSql) {
  const sql = stripCommentsAndStrings(rawSql);
  const found = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < sql.length && depth; i += 1) {
      if (sql[i] === '(') depth += 1;
      else if (sql[i] === ')') depth -= 1;
    }
    const end = sql.indexOf(';', i);
    found.push([m[1], sql.slice(i, end === -1 ? undefined : end)]);
    re.lastIndex = i;
  }
  return found;
}

const sources = [
  ['database/schema.sql', fs.readFileSync(path.join(root, 'database/schema.sql'), 'utf8')],
  ...fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'))
    .map(f => [`database/migrations/${f}`, fs.readFileSync(path.join(migrationsDir, f), 'utf8')]),
];

test('the scan finds the tables', () => {
  expect(createTables(sources[0][1]).length).toBeGreaterThan(300);
});

test('every CREATE TABLE declares COLLATE=', () => {
  const missing = sources.flatMap(([file, sql]) => createTables(sql)
    .filter(([, options]) => !/\bCOLLATE\s*=?\s*\w+/i.test(options))
    .map(([name]) => `${file}: ${name}`));
  expect(missing).toEqual([]);
});
