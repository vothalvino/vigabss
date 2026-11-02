// =============================================================================
// VigaBSS 5.0 — Schema-change advisory lock
// =============================================================================
// One MySQL/MariaDB advisory lock per target database serializes every schema
// writer: migrate.js (every pod's init container runs it) and rollback.js. A
// rollback that ran without it could interleave DDL with a pod restarting
// meanwhile, which also re-applied the files just rolled back (DB-19).
//
// The name hashes the database name so it stays under the 64-character limit
// and is identical for every process that targets the same database.
// =============================================================================

const crypto = require('crypto');

const LOCK_TIMEOUT_SECONDS = 300;

function migrationLockName(databaseName) {
  return `fireisp:migrate:${crypto.createHash('sha256').update(String(databaseName)).digest('hex').slice(0, 40)}`;
}

/**
 * Take the lock on `conn` for the database it is connected to.
 * @returns {Promise<string>} the lock name (pass it to releaseMigrationLock)
 */
async function acquireMigrationLock(conn, label, timeoutSeconds = LOCK_TIMEOUT_SECONDS) {
  const [databaseRows] = await conn.execute('SELECT DATABASE() AS database_name');
  const name = migrationLockName(databaseRows?.[0]?.database_name || label);
  const [lockRows] = await conn.execute('SELECT GET_LOCK(?, ?) AS acquired', [name, timeoutSeconds]);
  if (Number(lockRows?.[0]?.acquired) !== 1) {
    throw new Error(`Could not acquire the migration lock for ${label}`);
  }
  return name;
}

/** Release the lock; closing the connection releases it anyway. */
async function releaseMigrationLock(conn, name, logger, label) {
  try {
    await conn.execute('SELECT RELEASE_LOCK(?) AS released', [name]);
  } catch (err) {
    if (logger) logger.warn({ err, target: label }, 'Could not explicitly release migration lock; connection close will release it');
  }
}

module.exports = { migrationLockName, acquireMigrationLock, releaseMigrationLock, LOCK_TIMEOUT_SECONDS };
