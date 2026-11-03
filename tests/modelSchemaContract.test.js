'use strict';
// =============================================================================
// DB-20 — every model's fillable columns exist on its table
// =============================================================================
// BaseModel builds INSERT and UPDATE from `fillable`, which sql:check skips as
// dynamic SQL. 18 models listed columns their table does not have (renamed or
// never created), so a write naming one failed in production with "Unknown
// column". This keeps fillable in step with database/schema.sql.
// =============================================================================

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');

function columns(table) {
  const start = schema.search(new RegExp(`CREATE TABLE IF NOT EXISTS \`?${table}\`? \\(`));
  if (start === -1) return null;
  const body = schema.slice(start, schema.indexOf(') ENGINE', start));
  const cols = new Set();
  for (const line of body.split('\n').slice(1)) {
    const m = /^\s+`?([a-z_][a-z0-9_]*)`?\s+(?!KEY\b|INDEX\b)[A-Z]/i.exec(line);
    if (m && !/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK|FULLTEXT|SPATIAL)$/i.test(m[1])) cols.add(m[1]);
  }
  for (const alter of schema.matchAll(new RegExp(`ALTER TABLE \`?${table}\`?[\\s\\S]*?;`, 'g'))) {
    for (const c of alter[0].matchAll(/ADD COLUMN (?:IF NOT EXISTS )?`?([a-z_][a-z0-9_]*)`?/gi)) cols.add(c[1]);
  }
  return cols;
}

const modelDir = path.join(root, 'src', 'models');
const models = fs.readdirSync(modelDir)
  .filter(f => f.endsWith('.js') && f !== 'BaseModel.js')
  .map(f => [f, require(path.join(modelDir, f))])
  .filter(([, M]) => typeof M === 'function' && typeof M.tableName === 'string');

test('the scan covers the model catalog and reads real columns', () => {
  expect(models.length).toBeGreaterThan(50);
  expect([...columns('clients')]).toEqual(expect.arrayContaining(['organization_id', 'name', 'email']));
});

test.each(models)('%s: every fillable column exists on its table', (_f, M) => {
  const cols = columns(M.tableName);
  expect(cols).not.toBeNull();
  expect(M.fillable.filter(c => !cols.has(c))).toEqual([]);
});
