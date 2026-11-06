// =============================================================================
// DAL-09 — the hourly SNMP rollup window is half-open [from, to)
// =============================================================================
// snmp_rollup_to_1hr selected polled_at > v_from_ts, and last_processed is the
// hour boundary, so a sample stamped exactly HH:00:00 was in neither hour.

const fs = require('fs');
const path = require('path');
const { baselineProgram } = require('./helpers/baseline');

const root = path.join(__dirname, '..');

test('the baseline selects polled_at >= from AND < to', () => {
  const body = baselineProgram('procedure', 'snmp_rollup_to_1hr');
  expect(body).toMatch(/WHERE polled_at >= v_from_ts\s+AND polled_at <\s+v_to_ts/);
  expect(body).not.toMatch(/polled_at >\s+v_from_ts/);
});

test('schema.sql carries the same hourly window', () => {
  const schema = fs.readFileSync(path.join(root, 'database/schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE PROCEDURE IF NOT EXISTS snmp_rollup_to_1hr()');
  const body = schema.slice(start, schema.indexOf('END$$', start));
  expect(body).toMatch(/WHERE polled_at >= v_from_ts\s+AND polled_at <\s+v_to_ts/);
});

test('no later migration redefines the hourly rollup with the old window', () => {
  const dir = path.join(root, 'database/migrations');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql') && !f.startsWith('001_'))) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const at = sql.search(/CREATE PROCEDURE (IF NOT EXISTS )?`?snmp_rollup_to_1hr`?\(\)/);
    if (at === -1) continue;
    expect(sql.slice(at)).toMatch(/polled_at >= v_from_ts\s+AND polled_at <\s+v_to_ts/);
  }
});
