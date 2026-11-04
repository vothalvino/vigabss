// =============================================================================
// VigaBSS 5.0 — Re-encrypt stored secrets with the current ENCRYPTION_KEY
// =============================================================================
// Rotation (SEC-28, see src/utils/encryption.js):
//   1. Set the new key as ENCRYPTION_KEY and move the old one to
//      ENCRYPTION_KEYS_PREVIOUS; restart. Both keys now decrypt.
//   2. Run this script with --apply. It reads every text and JSON column of
//      every table, finds each value sealed (vb1:<key id>:…) by a key other
//      than the current one — a whole column value or one embedded in JSON —
//      and seals it again with the current key.
//   3. Run it again without --apply: when it reports nothing left under an
//      old key, remove that key from ENCRYPTION_KEYS_PREVIOUS.
//
// No list of encrypted columns to keep up to date: the key-id prefix is what
// identifies a sealed value. Each row is updated only if the column still
// holds the value that was read, so a concurrent save is never overwritten.
// Isolated-tenant databases are included unless --primary-only is given.
// Backup-code hashes cannot be re-keyed (the codes are not stored); they keep
// verifying while the old key is in ENCRYPTION_KEYS_PREVIOUS, and a user who
// regenerates their codes moves to the current key.
//
// STANDALONE and MANUALLY RUN; it is not registered in taskRunner.
//
// Usage:
//   node src/scripts/rotate-encryption-key.js                 # dry run (default)
//   node src/scripts/rotate-encryption-key.js --apply         # write
//   node src/scripts/rotate-encryption-key.js --primary-only  # skip isolated tenants
// =============================================================================

const { resealWithCurrentKey, currentKeyId, isConfigured } = require('../utils/encryption');

const TEXT_TYPES = ['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'json'];

const quote = name => `\`${String(name).replace(/`/g, '``')}\``;

/**
 * The text/JSON columns of the current database, grouped by table, with each
 * table's primary key. Tables without a primary key are reported, not read.
 */
async function textColumns(db) {
  const [columns] = await db.query(
    `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type
       FROM INFORMATION_SCHEMA.COLUMNS c
       JOIN INFORMATION_SCHEMA.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
      WHERE c.TABLE_SCHEMA = DATABASE() AND c.DATA_TYPE IN (?) AND c.EXTRA NOT LIKE '%GENERATED%'
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
    [TEXT_TYPES],
  );
  const [keys] = await db.query(
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  );
  const tables = new Map();
  for (const c of columns) {
    if (!tables.has(c.table_name)) tables.set(c.table_name, { columns: [], primaryKey: [] });
    tables.get(c.table_name).columns.push({ name: c.column_name, json: c.data_type === 'json' });
  }
  for (const k of keys) tables.get(k.table_name)?.primaryKey.push(k.column_name);
  return tables;
}

/**
 * @param {object} params
 * @param {object} params.db       query interface ({ query(sql, params) }) on one database
 * @param {boolean} [params.apply] write the re-sealed values (default: dry run)
 * @returns {Promise<{ values: number, resealed: number, unknown: number, skipped: number, failed: Array, details: Array }>}
 *   values: column values sealed by another key; unknown: sealed values whose
 *   key is not configured (left as they are); skipped: changed since read.
 */
async function rotateEncryptionKey({ db, apply = false }) {
  if (!isConfigured()) {
    throw Object.assign(new Error('ENCRYPTION_KEY is not set; nothing can be re-encrypted'), {
      code: 'ENCRYPTION_NOT_CONFIGURED',
    });
  }
  const current = currentKeyId();
  const summary = { values: 0, resealed: 0, unknown: 0, skipped: 0, failed: [], details: [] };

  for (const [table, { columns, primaryKey }] of await textColumns(db)) {
    for (const column of columns) {
      if (!primaryKey.length) {
        summary.failed.push({ table, column: column.name, reason: 'no primary key' });
        continue;
      }
      const text = `CAST(${quote(column.name)} AS CHAR)`;
      let rows;
      try {
        [rows] = await db.query(
          `SELECT ${primaryKey.map(quote).join(', ')}, ${text} AS sealed_value
             FROM ${quote(table)}
            WHERE ${quote(column.name)} LIKE '%vb1:%' AND ${quote(column.name)} NOT LIKE ?`,
          [`vb1:${current}:%`],
        );
      } catch (err) {
        summary.failed.push({ table, column: column.name, reason: err.message });
        continue;
      }
      for (const row of rows) {
        const result = resealWithCurrentKey(row.sealed_value);
        summary.unknown += result.unknown;
        if (!result.resealed) continue;
        summary.values++;
        const id = Object.fromEntries(primaryKey.map(k => [k, row[k]]));
        summary.details.push({ table, column: column.name, id, resealed: result.resealed });
        if (!apply) continue;
        const value = column.json ? 'CAST(? AS JSON)' : '?';
        try {
          const [update] = await db.query(
            `UPDATE ${quote(table)} SET ${quote(column.name)} = ${value}
              WHERE ${primaryKey.map(k => `${quote(k)} = ?`).join(' AND ')} AND ${text} = ?`,
            [result.text, ...primaryKey.map(k => row[k]), row.sealed_value],
          );
          if (Number(update.affectedRows) === 1) summary.resealed++;
          else summary.skipped++; // changed since it was read
        } catch (err) {
          summary.failed.push({ table, column: column.name, id, reason: err.message });
        }
      }
    }
  }
  return summary;
}

async function main() {
  require('dotenv').config();
  const mysql = require('mysql2/promise');
  const db = require('../config/database');
  const { listIsolatedMigrationTargets } = require('../services/tenantDatabaseService');
  const logger = require('../utils/logger').child({ script: 'rotate-encryption-key' });
  const apply = process.argv.includes('--apply');
  const targets = [{ label: db.baseConnectionConfig.database || 'primary', connectionConfig: db.baseConnectionConfig }];
  let failed = false;
  try {
    if (!process.argv.includes('--primary-only')) {
      for (const t of await listIsolatedMigrationTargets()) {
        targets.push({ label: `org:${t.organizationId}:${t.database}`, connectionConfig: t.connectionConfig });
      }
    }
    for (const target of targets) {
      const pool = mysql.createPool({ ...target.connectionConfig, connectionLimit: 1 });
      try {
        const result = await rotateEncryptionKey({ db: pool, apply });
        for (const d of result.details) logger.info({ target: target.label, ...d }, apply ? 'Re-encrypted' : 'Sealed by an old key');
        for (const f of result.failed) logger.warn({ target: target.label, ...f }, 'Column not processed');
        if (result.unknown) logger.error({ target: target.label, unknown: result.unknown }, 'Values sealed by a key that is not configured; add it to ENCRYPTION_KEYS_PREVIOUS');
        logger.info(
          { target: target.label, values: result.values, resealed: result.resealed, skipped: result.skipped, unknown: result.unknown, apply },
          apply ? 'Rotation complete' : 'Dry run complete — rerun with --apply to re-encrypt',
        );
        if (result.unknown || result.failed.length || result.skipped) failed = true;
      } finally {
        await pool.end();
      }
    }
    process.exitCode = failed ? 1 : 0;
  } catch (err) {
    logger.error({ err: err.message, code: err.code }, 'Key rotation failed');
    process.exitCode = 1;
  } finally {
    await db.close?.();
  }
}

if (require.main === module) main();

module.exports = { rotateEncryptionKey, TEXT_TYPES };
