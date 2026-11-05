#!/usr/bin/env node
// =============================================================================
// Generate src/models/ownedForeignKeys.json from database/schema.sql (TNA-38)
// =============================================================================
// crudController checks every foreign key a create or update writes against
// the caller's organization. The map comes from the FOREIGN KEY constraints in
// schema.sql, so a column's target is the table it really references, not a
// guess from its name. Only targets assertOwnedReferences knows are listed.
// The check is strict (the caller's organization only); a route whose module
// treats NULL-organization rows as shared passes { table, allowShared: true }
// for that field in its own ownedRefs option, which wins. A target in
// SHARED_TABLES (NULL-organization defaults) is listed with allowShared.
// tests/ownedForeignKeys.test.js fails when the committed file is stale.
//   node src/scripts/generate-owned-fks.js          # print
//   node src/scripts/generate-owned-fks.js --write  # update the file
// =============================================================================

const fs = require('fs');
const path = require('path');
const { OWNED_TABLES, SHARED_TABLES } = require('../utils/ownedReferences');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'src', 'models', 'ownedForeignKeys.json');

function tableBodies(schema) {
  const bodies = new Map();
  const re = /CREATE TABLE IF NOT EXISTS `?([a-z_][a-z0-9_]*)`? \(/g;
  let m;
  while ((m = re.exec(schema))) {
    const end = schema.indexOf(') ENGINE', m.index);
    bodies.set(m[1], schema.slice(m.index, end));
  }
  return bodies;
}

function generate(schema = fs.readFileSync(path.join(ROOT, 'database', 'schema.sql'), 'utf8')) {
  const bodies = tableBodies(schema);
  const map = {};
  for (const [table, body] of bodies) {
    for (const fk of body.matchAll(/FOREIGN KEY\s*\(\s*`?([a-z_][a-z0-9_]*)`?\s*\)\s*REFERENCES\s+`?([a-z_][a-z0-9_]*)`?\s*\(\s*`?id`?\s*\)/gi)) {
      const [, column, target] = fk;
      if (column === 'organization_id' || !OWNED_TABLES.has(target)) continue;
      map[table] = map[table] || {};
      map[table][column] = SHARED_TABLES.has(target) ? { table: target, allowShared: true } : target;
    }
  }
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
    .map(([t, cols]) => [t, Object.fromEntries(Object.entries(cols).sort(([a], [b]) => a.localeCompare(b)))]));
}

if (require.main === module) {
  const json = `${JSON.stringify(generate(), null, 2)}\n`;
  if (process.argv.includes('--write')) fs.writeFileSync(OUT, json);
  else process.stdout.write(json);
}

module.exports = { generate, OUT };
