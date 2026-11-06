/**
 * Tests for the rollback runner (src/scripts/rollback.js) and the rollback
 * SQL files in database/rollbacks/.
 *
 * These are pure unit tests — no database connection required.  They verify:
 *   1. Every migration after the baseline has a rollback with the same name.
 *   2. The baseline has none (it is the whole schema).
 *   3. Rollback SQL files are non-empty and reverse something.
 *   4. The rollback runner module exports runRollback.
 */

const fs   = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.resolve(__dirname, '../database/migrations');
const ROLLBACKS_DIR  = path.resolve(__dirname, '../database/rollbacks');

/** List .sql files in a directory, sorted. */
function listSqlFiles(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
}

/** Extract the numeric prefix from a migration filename. */
function migrationNumber(filename) {
  const m = filename.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : NaN;
}

describe('Rollback SQL files — database/rollbacks/', () => {
  it('the directory exists and says how rollbacks work', () => {
    expect(fs.existsSync(ROLLBACKS_DIR)).toBe(true);
    expect(fs.readFileSync(path.join(ROLLBACKS_DIR, 'README.md'), 'utf8')).toMatch(/001_baseline\.sql` has no rollback/);
  });

  // rollback.js matches by numeric prefix, so a migration without one cannot
  // be undone (and the CI round-trip fails); catch that here first.
  it('every migration after the baseline has a rollback with the same filename', () => {
    const rollbacks = new Set(listSqlFiles(ROLLBACKS_DIR));
    const missing = listSqlFiles(MIGRATIONS_DIR)
      .filter(f => migrationNumber(f) > 1 && !rollbacks.has(f));
    expect(missing).toEqual([]);
  });

  it('the baseline has no rollback', () => {
    expect(listSqlFiles(ROLLBACKS_DIR).filter(f => migrationNumber(f) === 1)).toEqual([]);
  });

  it('no rollback is left for a migration that does not exist', () => {
    const migrations = new Set(listSqlFiles(MIGRATIONS_DIR));
    expect(listSqlFiles(ROLLBACKS_DIR).filter(f => !migrations.has(f))).toEqual([]);
  });

  it('every rollback reverses something', () => {
    const empty = listSqlFiles(ROLLBACKS_DIR).filter((file) => {
      const content = fs.readFileSync(path.join(ROLLBACKS_DIR, file), 'utf8');
      return !/\b(DROP|ALTER|MODIFY|CHANGE|DELETE|UPDATE)\b/i.test(content);
    });
    expect(empty).toEqual([]);
  });
});

describe('Rollback runner — src/scripts/rollback.js', () => {
  // We only test the module exports (no DB calls)
  let rollbackModule;

  beforeAll(() => {
    // The module requires dotenv and db config — mock them to avoid errors
    jest.mock('../src/config/database', () => ({
      query: jest.fn(),
      close: jest.fn(),
      baseConnectionConfig: {},
    }));
    rollbackModule = require('../src/scripts/rollback');
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('exports runRollback function', () => {
    expect(typeof rollbackModule.runRollback).toBe('function');
  });
});
