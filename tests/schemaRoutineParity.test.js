// =============================================================================
// DAL-15 — schema.sql defines the same stored routines, triggers and events
// that the migrations leave behind, and snmp_maintain_partitions matches 248
// =============================================================================
// schema.sql kept the pre-248 snmp_maintain_partitions (its ensure-loop began
// next month, leaving the current month in p_future) and never defined
// preflight_check_event_scheduler (migration 053), which the README and
// deployment docs tell operators to CALL. No gate compared routines.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const RE = /\b(CREATE|DROP)\s+(?:DEFINER\s*=\s*\S+\s+)?(PROCEDURE|FUNCTION|TRIGGER|EVENT)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?`?(\w+)`?/gi;
const strip = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

function liveObjects(sqlTexts) {
  const live = new Set();
  for (const sql of sqlTexts) {
    for (const m of strip(sql).matchAll(RE)) {
      const key = `${m[2].toUpperCase()} ${m[3].toLowerCase()}`;
      if (m[1].toUpperCase() === 'CREATE') live.add(key); else live.delete(key);
    }
  }
  return live;
}

const migrationsDir = path.join(root, 'database/migrations');
const migrated = liveObjects(fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8')));
const schemaSql = fs.readFileSync(path.join(root, 'database/schema.sql'), 'utf8');
const fromSchema = liveObjects([schemaSql]);

test('every routine, trigger and event the migrations leave is in schema.sql', () => {
  expect([...migrated].filter((k) => !fromSchema.has(k)).sort()).toEqual([]);
});

test('schema.sql defines nothing the migrations do not', () => {
  expect([...fromSchema].filter((k) => !migrated.has(k)).sort()).toEqual([]);
});

test('snmp_maintain_partitions starts at the current month and runs at load time', () => {
  const body = schemaSql.slice(schemaSql.indexOf('PROCEDURE IF NOT EXISTS snmp_maintain_partitions'));
  const proc = body.slice(0, body.indexOf('END$$'));
  expect(proc).toContain("SET v_month = DATE_FORMAT(CURDATE(), '%Y-%m-01');");
  expect(schemaSql).toMatch(/^CALL snmp_maintain_partitions\(\);$/m);
});
