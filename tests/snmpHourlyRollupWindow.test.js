// =============================================================================
// DAL-09 — the hourly SNMP rollup window is half-open [from, to)
// =============================================================================
// snmp_rollup_to_1hr selected polled_at > v_from_ts, and last_processed is the
// hour boundary, so a sample stamped exactly HH:00:00 was in neither hour.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

function hourlyProcedure(sql) {
  const from = sql.indexOf('CREATE PROCEDURE snmp_rollup_to_1hr()');
  expect(from).toBeGreaterThanOrEqual(0);
  return sql.slice(from, sql.indexOf('END$$', from));
}

test.each([
  ['migration 497', 'database/migrations/497_snmp_hourly_rollup_half_open.sql'],
])('%s selects polled_at >= from AND < to', (_label, file) => {
  const body = hourlyProcedure(read(file));
  expect(body).toMatch(/WHERE polled_at >= v_from_ts\s+AND polled_at <\s+v_to_ts/);
  expect(body).not.toMatch(/polled_at >\s+v_from_ts/);
});

test('schema.sql carries the same hourly window', () => {
  const schema = read('database/schema.sql');
  const start = schema.indexOf('CREATE PROCEDURE IF NOT EXISTS snmp_rollup_to_1hr()');
  const body = schema.slice(start, schema.indexOf('END$$', start));
  expect(body).toMatch(/WHERE polled_at >= v_from_ts\s+AND polled_at <\s+v_to_ts/);
});

test('migration 497 is the latest definition of the hourly rollup', () => {
  const dir = path.join(root, 'database/migrations');
  const definers = fs.readdirSync(dir).filter(f => /CREATE PROCEDURE (IF NOT EXISTS )?snmp_rollup_to_1hr\(\)/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  expect(definers.sort().pop()).toBe('497_snmp_hourly_rollup_half_open.sql');
});
