'use strict';
// =============================================================================
// DB-20 / DB-06 — every model agrees with its table in database/schema.sql
// =============================================================================
// BaseModel builds INSERT, UPDATE and list SQL from `fillable`,
// `filterableColumns`, `hasOrgScope` and `softDelete`, which sql:check skips
// as dynamic SQL. 18 models listed columns their table does not have (renamed
// or never created), so a write naming one failed with "Unknown column", and
// BaseModel accepted a `status` list filter on every model, so ?status= on one
// of the 77 tables without that column was a 500 (DB-06).
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

// Tables whose organization_id is the row's identity or an install setting,
// not a tenant filter: the model is reached by organization id directly.
const ORG_COLUMN_WITHOUT_SCOPE = {
  'EmailSettings.js': 'per-organization SMTP identities, read by organization id and function',
  'OrganizationDatabaseConfig.js': 'install-level tenant routing registry, one row per organization',
  'OrganizationQuota.js': 'one quota row per organization, read by organization id',
};
// Tables with a deleted_at column that nothing sets: their rows are hard
// deleted, and the model must not hide or restore rows by it.
const DELETED_AT_WITHOUT_SOFT_DELETE = {
  'AdminIpAllowlist.js': 'entries are hard deleted; reads still filter deleted_at IS NULL',
  'DdosProtectionRule.js': 'rules are hard deleted',
  'DnsBlocklist.js': 'blocklists are hard deleted',
  'SecureDeletionLog.js': 'an evidence log; rows are never deleted',
};

test.each(models)('%s: every filterable column exists on its table', (_f, M) => {
  const cols = columns(M.tableName);
  expect(M.filterableColumns.filter(c => !cols.has(c))).toEqual([]);
});

test.each(models)('%s: hasOrgScope matches an organization_id column', (f, M) => {
  const cols = columns(M.tableName);
  if (M.hasOrgScope) expect(cols.has('organization_id')).toBe(true);
  else if (cols.has('organization_id')) expect(ORG_COLUMN_WITHOUT_SCOPE[f]).toEqual(expect.any(String));
});

test.each(models)('%s: softDelete matches a deleted_at column', (f, M) => {
  const cols = columns(M.tableName);
  if (M.softDelete) expect(cols.has('deleted_at')).toBe(true);
  else if (cols.has('deleted_at')) expect(DELETED_AT_WITHOUT_SOFT_DELETE[f]).toEqual(expect.any(String));
});

test('every reviewed exception is still a real model', () => {
  const files = new Set(models.map(([f]) => f));
  expect([...Object.keys(ORG_COLUMN_WITHOUT_SCOPE), ...Object.keys(DELETED_AT_WITHOUT_SOFT_DELETE)]
    .filter(f => !files.has(f))).toEqual([]);
});

describe('a status list filter only reaches tables that have the column', () => {
  const db = require('../src/config/database');
  beforeEach(() => jest.spyOn(db, 'query').mockResolvedValue([[{ total: 0 }]]));
  afterEach(() => jest.restoreAllMocks());

  test.each(models)('%s', async (_f, M) => {
    const declared = M.fillable.includes('status') || M.filterableColumns.includes('status');
    expect(declared).toBe(columns(M.tableName).has('status'));
    if (M.findAll !== require('../src/models/BaseModel').findAll) return; // custom list SQL
    const orgId = M.hasOrgScope ? 1 : undefined;
    await M.findAll({ where: { status: 'active' }, orgId });
    await M.count({ where: { status: 'active' }, orgId });
    for (const [sql] of db.query.mock.calls) expect(/`status` = \?/.test(sql)).toBe(declared);
  });
});
