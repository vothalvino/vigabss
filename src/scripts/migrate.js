// =============================================================================
// VigaBSS 5.0 — Migration Runner
// =============================================================================
// Reads each numbered .sql file in database/migrations/ and applies it if not
// already recorded in schema_migrations.
//
// Usage:  node src/scripts/migrate.js
//         npm run migrate
// =============================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const db = require('../config/database');
const logger = require('../utils/logger').child({ script: 'migrate' });
const { acquireMigrationLock, releaseMigrationLock } = require('../utils/migrationLock');
const { listMigrationFiles, migrationChecksum } = require('../utils/migrationFiles');
const product = require('../product');
const { listIsolatedMigrationTargets } = require('../services/tenantDatabaseService');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../database/migrations');
// The first release's whole schema; every later migration builds on it.
const BASELINE = '001_baseline.sql';

function parseBoolEnv(key, fallback = false) {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

/**
 * Split a SQL migration file into individual executable statements.
 *
 * Handles `DELIMITER $$` / `DELIMITER ;` directives that are understood by the
 * mysql CLI client but rejected by mysql2's prepared-statement protocol.  The
 * function tracks the current delimiter and emits one statement string per
 * delimiter occurrence so callers can execute them one by one via conn.query().
 *
 * @param {string} sql - Raw file content of a .sql migration file.
 * @returns {string[]} Array of non-empty SQL statement strings (no trailing delimiter).
 */
function splitStatements(sql) {
  const statements = [];
  let delimiter = ';';
  let current = '';

  // A DELIMITER directive can follow a file header made entirely of comments.
  // Sending that header as COM_QUERY produces ER_EMPTY_QUERY on MySQL. Remove
  // ordinary comments only for this emptiness check; preserve MySQL executable
  // comments (`/*! ... */`) and optimizer hints (`/*+ ... */`).
  const hasExecutableSql = value => value
    .replace(/\/\*(?![!+])[\s\S]*?\*\//g, '')
    .replace(/^\s*--(?:\s|$).*$/gm, '')
    .replace(/^\s*#.*$/gm, '')
    .trim().length > 0;

  // Process line by line so DELIMITER directives are easy to detect at line start.
  for (const rawLine of sql.split('\n')) {
    const trimmed = rawLine.trim();

    // DELIMITER directive: switch the current statement terminator.
    const delimMatch = trimmed.match(/^DELIMITER\s+(\S+)\s*$/i);
    if (delimMatch) {
      // Flush any accumulated text before the directive change.
      const pending = current.trim();
      if (pending && hasExecutableSql(pending)) {
        statements.push(pending);
      }
      current = '';
      delimiter = delimMatch[1];
      continue;
    }

    current += rawLine + '\n';

    // Check if the accumulated buffer ends with the current delimiter.
    // We compare against the trimmed tail of the buffer to ignore trailing
    // whitespace / newlines after the delimiter token.
    const trimmedCurrent = current.trimEnd();
    if (trimmedCurrent.endsWith(delimiter)) {
      // Strip the trailing delimiter before pushing.
      const stmt = trimmedCurrent.slice(0, trimmedCurrent.length - delimiter.length).trim();
      if (stmt && hasExecutableSql(stmt)) {
        statements.push(stmt);
      }
      current = '';
    }
  }

  // Flush any remaining content (e.g. files that don't end with a delimiter).
  const tail = current.trim();
  if (tail && hasExecutableSql(tail)) {
    statements.push(tail);
  }

  return statements;
}

function createMigrationPool(connectionConfig) {
  // Migrations may contain multiple SQL statements per file, so we use a
  // dedicated connection with multipleStatements enabled (the main pool
  // intentionally disables this for security).
  return mysql.createPool({
    ...connectionConfig,
    waitForConnections: true,
    connectionLimit: 1,
    multipleStatements: true,
  });
}

// schema_migrations belongs to the runner, so the runner adds the checksum
// column (DB-21) to a table created before it existed.
async function ensureChecksumColumn(conn) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = 'checksum'`,
  );
  if (!rows.length) {
    await conn.query('ALTER TABLE schema_migrations ADD COLUMN checksum CHAR(64) NULL AFTER applied_at');
  }
}

// migrationsDir is for tests; installs always read database/migrations.
async function applyMigrations(migrationPool, label = 'primary', { migrationsDir = MIGRATIONS_DIR } = {}) {

  let conn;
  let migrationLockName;
  let migrationLockHeld = false;
  try {
    conn = await migrationPool.getConnection();

    // Helm/Kubernetes may start more than one new pod at once. Every pod uses
    // the same image-level migration command before its application process,
    // so serialize writers per target database with a server advisory lock.
    // The hash keeps the lock below MySQL/MariaDB's 64-character limit while
    // making the name stable across processes that target the same label.
    // Shared with rollback.js (src/utils/migrationLock.js).
    migrationLockName = await acquireMigrationLock(conn, label);
    migrationLockHeld = true;

    // Ensure schema_migrations table exists (migration 052 creates it, but
    // we need it before running any migrations on a fresh DB).
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
        filename   VARCHAR(255)     NOT NULL,
        applied_at TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        checksum   CHAR(64)         NULL,
        UNIQUE KEY uq_schema_migrations_filename (filename)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await ensureChecksumColumn(conn);

    // Fetch already-applied filenames and the checksums they were applied with
    const [applied] = await conn.execute('SELECT filename, checksum FROM schema_migrations');
    const appliedChecksums = new Map(applied.map(r => [r.filename, r.checksum]));

    // DB-21: numeric order, so '1000_x.sql' runs after '999_x.sql'.
    const files = listMigrationFiles(migrationsDir);

    // A database built from the development history (before the migrations
    // were squashed into 001_baseline.sql) has none of today's filenames, and
    // applying the baseline on top of it would fail on the first existing
    // table. Say what happened instead.
    if (files[0] === BASELINE && applied.length > 0 && !appliedChecksums.has(BASELINE)) {
      throw new Error(
        `${label} was created from the pre-release migration history (${applied.length} migrations, `
        + `none of them ${BASELINE}). Nothing was changed. Recreate it from the baseline: `
        + 'drop and create the database, then run the migrations again.',
      );
    }

    let count = 0;
    const changed = [];
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const checksum = migrationChecksum(sql);
      if (appliedChecksums.has(file)) {
        const recorded = appliedChecksums.get(file);
        if (!recorded) {
          await conn.execute('UPDATE schema_migrations SET checksum = ? WHERE filename = ?', [checksum, file]);
        } else if (recorded !== checksum) {
          changed.push(file);
        }
        continue;
      }

      logger.info({ file, target: label }, 'Applying migration');

      try {
        for (const stmt of splitStatements(sql)) {
          await conn.query(stmt);
        }
        await conn.execute(
          'INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)',
          [file, checksum],
        );
        count++;
      } catch (err) {
        logger.error({ err, file }, 'Migration failed');
        throw err;
      }
    }

    // An applied migration whose statements changed afterwards is not
    // re-run: the database keeps what the old text did. Warn rather than
    // fail, so a corrected guard in a shipped file cannot block an upgrade.
    if (changed.length) {
      logger.warn({ target: label, files: changed },
        'Applied migrations have changed since they ran; their changes are not applied to this database');
    }

    if (count === 0) {
      logger.info({ target: label }, 'All migrations are up to date.');
    } else {
      logger.info({ count, target: label }, 'Migrations applied');
    }
  } finally {
    if (conn && migrationLockHeld) {
      await releaseMigrationLock(conn, migrationLockName, logger, label);
    }
    if (conn) conn.release();
  }
}

async function runMigrations(options = {}) {
  const includeIsolatedTenants = options.includeIsolatedTenants
    ?? parseBoolEnv('MIGRATE_ISOLATED_TENANTS', false);
  const primaryPool = createMigrationPool(db.baseConnectionConfig);

  try {
    try {
      await applyMigrations(primaryPool, db.baseConnectionConfig.database);
    } finally {
      await primaryPool.end();
    }

    if (includeIsolatedTenants) {
      const targets = await listIsolatedMigrationTargets();
      for (const target of targets) {
        const tenantPool = createMigrationPool(target.connectionConfig);
        try {
          await applyMigrations(tenantPool, `org:${target.organizationId}:${target.database}`);
        } finally {
          await tenantPool.end();
        }
      }
    }
  } finally {
    await db.close();
  }
}

// Run when invoked directly
if (require.main === module) {
  logger.info(`${product.displayName} — Running migrations...`);
  runMigrations()
    .then(() => {
      logger.info('Done.');
      process.exit(0);
    })
    .catch(err => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}

module.exports = { runMigrations, splitStatements, createMigrationPool, applyMigrations };
