// =============================================================================
// DB-09 — a failed SQL assertion fails CI
// =============================================================================
// CI piped each tests/test_*.sql into mysql and then echoed "All SQL tests
// passed". The assert_* procedures only record a row and print '✗ FAIL', and
// test_summary never raised, so the mysql client exited 0: twelve failing
// assertions sat in a green job. test_summary now SIGNALs on any failure and
// the suite also runs against the migrated database.
// =============================================================================

const fs = require('fs');
const path = require('path');

const helpers = fs.readFileSync(path.join(__dirname, 'test_helpers.sql'), 'utf8');
const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

test('test_summary raises an SQL error when any assertion failed', () => {
  const body = helpers.slice(helpers.indexOf('CREATE PROCEDURE test_summary()'), helpers.indexOf('END$$', helpers.indexOf('CREATE PROCEDURE test_summary()')));
  expect(body).toMatch(/IF v_total_fail > 0 THEN\s+SIGNAL SQLSTATE '45000'/);
});

test('every SQL test file ends with test_summary, so its failures surface', () => {
  const files = fs.readdirSync(__dirname).filter((f) => /^test_.*\.sql$/.test(f) && f !== 'test_helpers.sql');
  expect(files.length).toBeGreaterThan(5);
  for (const f of files) expect(fs.readFileSync(path.join(__dirname, f), 'utf8')).toMatch(/CALL test_summary\(\)/);
});

test('CI runs the suite on schema.sql and on the migrated database, stopping on the first error', () => {
  for (const [step, db] of [['Run SQL test suite', 'fireisp_test'], ['Run SQL test suite against the migrated database', 'fireisp_migrate_test']]) {
    const start = ci.indexOf(`- name: ${step}\n`);
    expect(start).toBeGreaterThan(-1);
    const block = ci.slice(start, ci.indexOf('- name:', start + 10));
    expect(block).toMatch(/set -euo pipefail/);
    expect(block).toContain(`${db} < "$f"`);
  }
});
