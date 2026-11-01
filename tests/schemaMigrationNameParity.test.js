// =============================================================================
// DB-09 follow-up — every named constraint in schema.sql is created by a
// migration
// =============================================================================
// Running the SQL suite against the migrated database found two CHECK
// constraints that only schema.sql declared (chk_ift_statistical_reports_period,
// chk_regulatory_filings_period) and a unique key named differently in the
// two. Installs are built by migrations, so schema.sql must not promise a
// constraint they never create.
// =============================================================================

const fs = require('fs');
const path = require('path');

const dbDir = path.join(__dirname, '..', 'database');
const schema = fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8');
const migrations = fs.readdirSync(path.join(dbDir, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => fs.readFileSync(path.join(dbDir, 'migrations', f), 'utf8'))
  .join('\n');

const named = (re) => [...new Set([...schema.matchAll(re)].map((m) => m[1]))];

test.each([
  ['CHECK constraint', /CONSTRAINT (chk_\w+) CHECK/g],
  ['trigger', /CREATE TRIGGER (\w+)/g],
  ['unique key', /UNIQUE KEY (\w+)/g],
])('every %s named in schema.sql is created by a migration', (_kind, re) => {
  const names = named(re);
  expect(names.length).toBeGreaterThan(0);
  expect(names.filter((n) => !new RegExp(`\\b${n}\\b`).test(migrations))).toEqual([]);
});
