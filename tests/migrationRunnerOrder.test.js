// =============================================================================
// DB-21 — migration order, checksums and re-execution safety
// =============================================================================
// migrate.js recorded only filenames and ordered files with a plain .sort(),
// so '1000_x.sql' would run before '101_x.sql' and an applied migration edited
// afterwards went unnoticed. A migration that created procedures without first
// dropping them could not be repeated after an interrupted run.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/config/database', () => ({
  baseConnectionConfig: { database: 'fireisp_test' },
  close: jest.fn(),
}));
jest.mock('../src/utils/logger', () => {
  const mock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn(() => mock) };
  return mock;
});

const logger = require('../src/utils/logger');
const {
  migrationNumber, listMigrationFiles, migrationChecksum,
} = require('../src/utils/migrationFiles');
const { applyMigrations } = require('../src/scripts/migrate');

const MIGRATIONS = path.join(__dirname, '..', 'database', 'migrations');
const files = listMigrationFiles(MIGRATIONS);

// The checksum tests need several applied files; the repository has the
// baseline and the migrations after it, so they run on a fixture directory.
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'db21-runner-'));
const fixtureFiles = ['001_baseline.sql', '002_second.sql', '003_third.sql', '004_pending.sql'];
fixtureFiles.forEach((name, i) => fs.writeFileSync(path.join(FIXTURE, name), `CREATE TABLE IF NOT EXISTS t${i} (id INT);\n`));
afterAll(() => fs.rmSync(FIXTURE, { recursive: true, force: true }));
const checksumOf = file => migrationChecksum(fs.readFileSync(path.join(FIXTURE, file), 'utf8'));

describe('numeric order', () => {
  test('a four-digit prefix sorts after the three-digit ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db21-'));
    for (const name of ['999_last_three.sql', '1000_first_four.sql', '101_x.sql', 'README.md']) {
      fs.writeFileSync(path.join(dir, name), '');
    }
    expect(listMigrationFiles(dir)).toEqual(['101_x.sql', '999_last_three.sql', '1000_first_four.sql']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('every migration has a unique numeric prefix', () => {
    const numbers = files.map(migrationNumber);
    expect(numbers.every(Number.isSafeInteger)).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe('checksums', () => {
  test('comments and whitespace do not change the checksum; statements do', () => {
    const base = migrationChecksum('-- header\nALTER TABLE t ADD COLUMN c INT; /* note */\n# hash comment\n');
    expect(migrationChecksum('-- reworded header\n\nALTER TABLE t   ADD COLUMN c INT;\n')).toBe(base);
    expect(migrationChecksum('ALTER TABLE t ADD COLUMN c BIGINT;')).not.toBe(base);
  });

  function connection(appliedRows) {
    return {
      execute: jest.fn(async (sql) => {
        if (/SELECT DATABASE\(\)/.test(sql)) return [[{ database_name: 'fireisp_test' }]];
        if (/GET_LOCK/.test(sql)) return [[{ acquired: 1 }]];
        if (/INFORMATION_SCHEMA\.COLUMNS/.test(sql)) return [[{ 1: 1 }]];
        if (/SELECT filename, checksum FROM schema_migrations/.test(sql)) return [appliedRows];
        if (/RELEASE_LOCK/.test(sql)) return [[{ released: 1 }]];
        return [{ affectedRows: 1 }];
      }),
      query: jest.fn().mockResolvedValue([{}]),
      release: jest.fn(),
    };
  }

  test('records new checksums, backfills missing ones and warns about changed files', async () => {
    const [first, second, ...rest] = fixtureFiles;
    const pending = rest.pop();
    const applied = [
      { filename: first, checksum: null },
      { filename: second, checksum: 'f'.repeat(64) },
      ...rest.map(filename => ({ filename, checksum: checksumOf(filename) })),
    ];
    const conn = connection(applied);

    await applyMigrations({ getConnection: async () => conn }, 'primary:fireisp_test', { migrationsDir: FIXTURE });

    const calls = conn.execute.mock.calls;
    expect(calls).toContainEqual(['UPDATE schema_migrations SET checksum = ? WHERE filename = ?', [checksumOf(first), first]]);
    expect(calls).toContainEqual(['INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)', [pending, checksumOf(pending)]]);
    expect(calls.filter(([sql]) => /^INSERT INTO schema_migrations/.test(sql))).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ files: [second] }),
      expect.stringMatching(/changed since they ran/),
    );
  });

  test('a schema_migrations table without the column gets it before anything runs', async () => {
    const conn = connection(fixtureFiles.map(filename => ({ filename, checksum: checksumOf(filename) })));
    conn.execute.mockImplementation(async (sql) => {
      if (/GET_LOCK/.test(sql)) return [[{ acquired: 1 }]];
      if (/INFORMATION_SCHEMA\.COLUMNS/.test(sql)) return [[]];
      if (/SELECT filename, checksum/.test(sql)) return [fixtureFiles.map(filename => ({ filename, checksum: checksumOf(filename) }))];
      if (/RELEASE_LOCK/.test(sql)) return [[{ released: 1 }]];
      return [[{ database_name: 'fireisp_test' }]];
    });

    await applyMigrations({ getConnection: async () => conn }, 'primary:fireisp_test', { migrationsDir: FIXTURE });

    expect(conn.query).toHaveBeenCalledWith(expect.stringMatching(/ALTER TABLE schema_migrations ADD COLUMN checksum CHAR\(64\)/));
  });
});

describe('re-execution safety', () => {
  const read = file => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');

  test('every stored routine is dropped before it is created', () => {
    const offenders = [];
    for (const file of files) {
      const sql = read(file);
      for (const m of sql.matchAll(/CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(PROCEDURE|FUNCTION|TRIGGER|EVENT)\s+(IF\s+NOT\s+EXISTS\s+)?`?(\w+)/gi)) {
        if (m[2]) continue; // CREATE ... IF NOT EXISTS repeats safely
        const dropped = new RegExp(`DROP\\s+${m[1]}\\s+IF\\s+EXISTS\\s+\`?${m[3]}\\b`, 'i');
        if (!dropped.test(sql.slice(0, m.index))) offenders.push(`${file}: ${m[1]} ${m[3]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Every migration after the baseline can be run again after a partial
  // failure: its DDL is guarded and its seeds do not duplicate rows. CI
  // re-runs them. The baseline itself runs once on an empty database.
  test('migrations after the baseline have only guarded DDL and seeds', () => {
    const offenders = [];
    for (const file of files.filter(f => migrationNumber(f) > 1)) {
      // Statements inside a routine body run behind its own guards.
      const sql = read(file).replace(/CREATE\s+PROCEDURE[\s\S]*?\bEND\s*(\/\/|\$\$)/gi, '');
      for (const raw of sql.split(';')) {
        const stmt = raw.replace(/\s+/g, ' ').trim();
        if (/^ALTER TABLE/i.test(stmt)) offenders.push(`${file}: unguarded ALTER TABLE`);
        if (/^CREATE (UNIQUE )?INDEX/i.test(stmt)) offenders.push(`${file}: unguarded CREATE INDEX`);
        if (/^CREATE TABLE (?!IF NOT EXISTS)/i.test(stmt)) offenders.push(`${file}: CREATE TABLE without IF NOT EXISTS`);
        if (/^INSERT (?!IGNORE)/i.test(stmt) && !/WHERE NOT EXISTS|ON DUPLICATE KEY UPDATE/i.test(stmt)) {
          offenders.push(`${file}: INSERT that duplicates rows when repeated`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
