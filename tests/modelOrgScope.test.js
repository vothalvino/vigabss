// =============================================================================
// TNA-39 — every model's hasOrgScope matches its table's organization_id
// =============================================================================
// 8 models had organization_id in schema.sql but hasOrgScope=false, and 8
// claimed hasOrgScope for tables without the column (BaseModel would then add
// `organization_id = ?` to a table that has none). Most were dead and are
// removed; the rest declare a reviewed orgScopeExempt reason.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');

function tableHasOrgColumn(table) {
  const start = schema.search(new RegExp(`CREATE TABLE IF NOT EXISTS \`?${table}\`? \\(`));
  if (start === -1) return null;
  const body = schema.slice(start, schema.indexOf(') ENGINE', start));
  return /\n\s+`?organization_id`?\s/.test(body);
}

const modelDir = path.join(root, 'src', 'models');
const models = fs.readdirSync(modelDir)
  .filter((f) => f.endsWith('.js') && f !== 'BaseModel.js')
  .map((f) => [f, require(path.join(modelDir, f))])
  .filter(([, M]) => typeof M === 'function' && typeof M.tableName === 'string');

test('the scan covers the model catalog', () => {
  expect(models.length).toBeGreaterThan(50);
});

test.each(models.map(([f, M]) => [f, M]))('%s: hasOrgScope matches organization_id', (_f, M) => {
  const hasColumn = tableHasOrgColumn(M.tableName);
  expect(hasColumn).not.toBeNull(); // the table exists in schema.sql
  if (M.orgScopeExempt) {
    // An exemption must still be needed, or it hides a later fix.
    expect(M.hasOrgScope).not.toBe(hasColumn);
  } else {
    expect(M.hasOrgScope).toBe(hasColumn);
  }
});
