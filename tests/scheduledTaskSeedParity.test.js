// =============================================================================
// ASY-20 — every scheduled task schema.sql seeds is also seeded by a migration
// =============================================================================
// Installs are built by migrate.js, not schema.sql. sms_send was seeded only in
// schema.sql, so migrated installs never drained queued SMS (without Redis) or
// recovered stale delivery claims. A task that exists only in schema.sql never
// runs on an upgraded or migration-built install.
// =============================================================================

const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, '..', 'database');

function seededTaskNames(sql) {
  const names = new Set();
  for (const [statement] of sql.matchAll(/INSERT[^;]*?INTO\s+scheduled_tasks[\s\S]*?;/gi)) {
    for (const [, name] of statement.matchAll(/'([a-z][a-z0-9_]+)'/g)) names.add(name);
  }
  return names;
}

// Quoted literals in a seed include task types, priorities and descriptions;
// only names the task runner dispatches are task names.
const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'taskRunner.js'), 'utf8');
const isTaskName = (name) => runner.includes(`'${name}'`);

test('schema.sql seeds no scheduled task that the migrations do not', () => {
  const schema = seededTaskNames(fs.readFileSync(path.join(DB, 'schema.sql'), 'utf8'));
  const migrated = new Set();
  for (const file of fs.readdirSync(path.join(DB, 'migrations'))) {
    for (const name of seededTaskNames(fs.readFileSync(path.join(DB, 'migrations', file), 'utf8'))) migrated.add(name);
  }
  const schemaOnly = [...schema].filter(isTaskName).filter((name) => !migrated.has(name));
  expect(schemaOnly).toEqual([]);
  expect(migrated.has('sms_send')).toBe(true);
});
