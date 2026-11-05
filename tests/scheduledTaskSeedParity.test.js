// =============================================================================
// ASY-20 — every scheduled task schema.sql seeds is also seeded by a migration
// =============================================================================
// Installs are built by migrate.js, not schema.sql. sms_send was once seeded
// only in schema.sql, so migrated installs never drained queued SMS (without
// Redis) or recovered stale delivery claims. A task that exists only in
// schema.sql never runs on a migration-built install. Both sides are read as
// rows (by task_name), not as text: a task_type such as 'snmp_poll' is not a
// task.
// =============================================================================

const { migratedSeeds, schemaSeeds } = require('./helpers/scheduledTaskSeeds');

test('schema.sql seeds no scheduled task that the migrations do not', () => {
  const migrated = new Set(migratedSeeds().map(row => row.task_name));
  const schemaOnly = schemaSeeds().map(row => row.task_name).filter(name => !migrated.has(name));
  expect(migrated.size).toBeGreaterThan(50);
  expect(schemaOnly).toEqual([]);
});
