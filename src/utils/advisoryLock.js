'use strict';

// =============================================================================
// MySQL advisory locks held for the length of a piece of work
// =============================================================================
// GET_LOCK on a session from the separate lock pool (db.getLockConnection), so
// the same work never runs twice at once in this process or another. The name
// is prefixed with a hash of the database name: two installs sharing a MySQL
// server do not block each other.
// =============================================================================

const crypto = require('crypto');
const db = require('../config/database');
const logger = require('./logger').child({ service: 'advisoryLock' });

const lockDatabaseName = db.baseConnectionConfig?.database || process.env.DB_NAME || 'fireisp';
const LOCK_PREFIX = `fireisp:${crypto.createHash('sha256').update(lockDatabaseName).digest('hex').slice(0, 16)}:`;

/**
 * Run `fn` while holding the named lock. Without the lock, `fn` does not run.
 * `claim(connection)` may refuse the run after the lock is taken.
 * @param {string} key - e.g. 'scheduled-task:12'
 * @returns {Promise<boolean>} whether `fn` ran
 */
async function withAdvisoryLock(key, fn, claim = null) {
  const connection = await db.getLockConnection();
  const lockName = `${LOCK_PREFIX}${key}`;
  let locked = false;
  let discardConnection = false;
  try {
    const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    locked = Number(rows[0]?.acquired) === 1;
    if (!locked) {
      logger.debug({ key }, 'Already running elsewhere');
      return false;
    }
    if (claim && !await claim(connection)) return false;
    await fn();
    return true;
  } finally {
    if (locked) {
      try {
        const [rows] = await connection.query('SELECT RELEASE_LOCK(?) AS released', [lockName]);
        if (Number(rows[0]?.released) !== 1) discardConnection = true;
      } catch (err) {
        discardConnection = true;
        logger.error({ err: err.message, key }, 'Could not release the advisory lock');
      }
    }
    // Never return a possibly lock-owning session to the pool.
    if (discardConnection && typeof connection.destroy === 'function') connection.destroy();
    else connection.release();
  }
}

module.exports = { withAdvisoryLock, LOCK_PREFIX };
