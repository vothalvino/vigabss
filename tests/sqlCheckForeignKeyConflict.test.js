// =============================================================================
// A CHECK constraint never names a column whose foreign key cascades
// =============================================================================
// MySQL (error 3823) and MariaDB (error 1901) refuse a CHECK on a column that
// a foreign key with ON DELETE/UPDATE CASCADE or SET NULL uses. Migration 514
// shipped one; the mocked suites cannot see it, and only the real database in
// CI refused it. This reads every CREATE TABLE and fails on the combination.
// =============================================================================

const fs = require('fs');
const path = require('path');

function conflicts(sql) {
  const found = [];
  // One table at a time: its body ends at ENGINE= or at the next CREATE TABLE.
  for (const chunk of sql.split(/CREATE TABLE IF NOT EXISTS\s+/).slice(1)) {
    const table = chunk.match(/^`?(\w+)`?/)[1];
    const body = chunk.split(/\bENGINE\s*=/)[0];
    const code = body.replace(/--.*$/gm, '');
    const cascading = new Set();
    for (const fk of code.matchAll(/FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES[^,]*?ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET NULL)[^,]*/gi)) {
      for (const col of fk[1].split(',')) cascading.add(col.replace(/`/g, '').trim());
    }
    const checks = [...code.matchAll(/CHECK\s*\(([\s\S]*?)\)\s*(?:,|$)/gi)].map(c => c[1]).join(' ');
    for (const col of cascading) {
      if (new RegExp(`\\b${col}\\b`).test(checks)) found.push(`${table}.${col}`);
    }
  }
  return found;
}

describe('CHECK and cascading foreign keys', () => {
  const root = path.join(__dirname, '..', 'database');
  const files = [
    path.join(root, 'schema.sql'),
    ...fs.readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).map(f => path.join(root, 'migrations', f)),
  ];

  test('the detector catches the table migration 514 first shipped', () => {
    const sql = `CREATE TABLE IF NOT EXISTS t (
    a BIGINT UNSIGNED NULL,
    CONSTRAINT chk_a CHECK (a IS NOT NULL),
    CONSTRAINT fk_a FOREIGN KEY (a) REFERENCES x (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;`;
    expect(conflicts(sql)).toEqual(['t.a']);
    expect(conflicts(sql.replace('ON UPDATE CASCADE', 'ON UPDATE RESTRICT'))).toEqual([]);
  });

  test.each(files.map(f => [path.relative(root, f), f]))('%s', (_name, file) => {
    expect(conflicts(fs.readFileSync(file, 'utf8'))).toEqual([]);
  });
});
