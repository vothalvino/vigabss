// =============================================================================
// VigaBSS 5.0 — One-off backfill: encrypt plaintext gateway and PAC credentials
// =============================================================================
// Before the write-only credential fields (src/utils/sealSecrets.js), the
// payment-gateway and PAC settings routes stored whatever the client sent in
// the *_encrypted columns, so they hold PLAINTEXT secrets even on installs that
// set ENCRYPTION_KEY. Readers use decrypt(), which passes plaintext through, so
// those rows keep working — this script only removes the plaintext at rest.
//
// A value counts as already encrypted when decryptStrict() authenticates it
// with the current ENCRYPTION_KEY; anything else non-empty is encrypted. Each
// row is updated only if the column still holds the value that was read, so a
// concurrent settings save is never overwritten. Safe to rerun.
//
// STANDALONE and MANUALLY RUN; it is not registered in taskRunner.
//
// Usage:
//   node src/scripts/encrypt-plaintext-credentials.js           # dry run (default)
//   node src/scripts/encrypt-plaintext-credentials.js --apply   # write
// =============================================================================

const { encryptStrict, decryptStrict, isConfigured } = require('../utils/encryption');

const TARGETS = [
  { table: 'payment_gateways', columns: ['secret_key_encrypted', 'webhook_secret_encrypted'] },
  { table: 'pac_providers', columns: ['username_encrypted', 'password_encrypted', 'api_key_encrypted', 'token_encrypted'] },
];

function isEncrypted(value) {
  try {
    decryptStrict(value);
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * @param {object} params
 * @param {object} params.db       query interface ({ query(sql, params) })
 * @param {boolean} [params.apply] write the encrypted values (default: dry run)
 * @returns {Promise<{ found: number, encrypted: number, skipped: number, details: Array }>}
 */
async function encryptPlaintextCredentials({ db, apply = false }) {
  if (!isConfigured()) {
    throw Object.assign(new Error('ENCRYPTION_KEY is not set; nothing can be encrypted'), {
      code: 'ENCRYPTION_NOT_CONFIGURED',
    });
  }

  let found = 0;
  let encrypted = 0;
  let skipped = 0;
  const details = [];

  for (const { table, columns } of TARGETS) {
    const [rows] = await db.query(`SELECT id, ${columns.join(', ')} FROM ${table}`);
    for (const row of rows) {
      for (const column of columns) {
        const value = row[column];
        if (value === null || value === undefined || value === '') continue;
        if (isEncrypted(value)) continue;
        found++;
        details.push({ table, id: row.id, column });
        if (!apply) continue;
        const [result] = await db.query(
          `UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} = ?`,
          [encryptStrict(value), row.id, value],
        );
        if (result.affectedRows === 1) encrypted++;
        else skipped++; // changed since it was read
      }
    }
  }

  return { found, encrypted, skipped, details };
}

async function main() {
  require('dotenv').config();
  const db = require('../config/database');
  const logger = require('../utils/logger').child({ script: 'encrypt-plaintext-credentials' });
  const apply = process.argv.includes('--apply');
  try {
    const result = await encryptPlaintextCredentials({ db, apply });
    for (const d of result.details) logger.info(d, apply ? 'Encrypted plaintext credential' : 'Plaintext credential found');
    logger.info(
      { found: result.found, encrypted: result.encrypted, skipped: result.skipped, apply },
      apply ? 'Credential backfill complete' : 'Dry run complete — rerun with --apply to encrypt',
    );
    process.exitCode = 0;
  } catch (err) {
    logger.error({ err: err.message, code: err.code }, 'Credential backfill failed');
    process.exitCode = 1;
  } finally {
    await db.close?.();
  }
}

if (require.main === module) main();

module.exports = { encryptPlaintextCredentials, TARGETS };
