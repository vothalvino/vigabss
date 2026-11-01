#!/usr/bin/env node
'use strict';

// =============================================================================
// Pre-migration backup (OPS-14)
// =============================================================================
// Migrations are forward-only. redeploy (and the unattended GUI Update) used to
// stop the app and migrate production without any dump first, so a migration
// that failed halfway or mis-transformed data left only the previous night's
// scheduled backup — and that backup covers the primary database alone, while
// migrate.js with MIGRATE_ISOLATED_TENANTS also alters every isolated tenant
// database.
//
// This dumps every database that has a migration pending (the primary and each
// isolated tenant) into BACKUP_DIR/pre-migration-<timestamp>/, prints the
// restore commands, keeps the newest PRE_MIGRATION_BACKUP_KEEP sets (3), and
// exits non-zero if any dump fails so the caller does not migrate.
// PRE_MIGRATION_BACKUP=0 skips it.
// =============================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const db = require('../config/database');
const logger = require('../utils/logger').child({ script: 'pre-migration-backup' });
const { runDump, BACKUP_DIR, MIN_BACKUP_BYTES } = require('./backup');
const { listIsolatedMigrationTargets } = require('../services/tenantDatabaseService');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../database/migrations');
const KEEP = Math.max(1, parseInt(process.env.PRE_MIGRATION_BACKUP_KEEP || '3', 10) || 3);
const SET_PREFIX = 'pre-migration-';

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
}

/**
 * Number of migrations not yet recorded for this database, or null for a
 * database with no schema_migrations table (a fresh install: nothing to keep).
 */
async function pendingCount(connectionConfig, files) {
  const conn = await mysql.createConnection(connectionConfig);
  try {
    const [tables] = await conn.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'",
    );
    if (tables.length === 0) return null;
    const [rows] = await conn.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    return files.filter((f) => !applied.has(f)).length;
  } finally {
    await conn.end();
  }
}

function rotateSets(dir, keep) {
  const sets = fs.readdirSync(dir)
    .filter((name) => name.startsWith(SET_PREFIX) && fs.statSync(path.join(dir, name)).isDirectory())
    .sort()
    .reverse();
  for (const old of sets.slice(keep)) {
    fs.rmSync(path.join(dir, old), { recursive: true, force: true });
    logger.info({ set: old }, 'Removed an older pre-migration backup set');
  }
}

async function preMigrationBackup({ includeIsolatedTenants = process.env.MIGRATE_ISOLATED_TENANTS === 'true' } = {}) {
  if (['0', 'false', 'no', 'off'].includes(String(process.env.PRE_MIGRATION_BACKUP || '').toLowerCase())) {
    logger.warn('PRE_MIGRATION_BACKUP is off — migrating without a backup');
    return { skipped: true, files: [] };
  }

  const files = migrationFiles();
  const primary = db.baseConnectionConfig;
  const targets = [{ label: primary.database, connectionConfig: primary }];
  if (includeIsolatedTenants) {
    for (const t of await listIsolatedMigrationTargets()) {
      targets.push({ label: `org ${t.organizationId} (${t.database})`, connectionConfig: t.connectionConfig });
    }
  }

  const due = [];
  for (const target of targets) {
    const pending = await pendingCount(target.connectionConfig, files);
    if (pending === null) {
      logger.info({ target: target.label }, 'Fresh database (no schema_migrations) — nothing to back up');
    } else if (pending > 0) {
      due.push(target);
    }
  }
  if (due.length === 0) {
    logger.info('No pending migrations — no pre-migration backup needed');
    return { skipped: true, files: [] };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const setDir = path.join(BACKUP_DIR, `${SET_PREFIX}${stamp}`);
  fs.mkdirSync(setDir, { recursive: true });

  const written = [];
  for (const target of due) {
    const { host, port, user, password, database } = target.connectionConfig;
    const filepath = path.join(setDir, `${database}.sql.gz`);
    await runDump({ host, port: String(port || 3306), user, password: password || '', database, filepath });
    const { size } = fs.statSync(filepath);
    if (size < MIN_BACKUP_BYTES) {
      throw new Error(`Pre-migration dump of ${database} is suspiciously small (${size} bytes)`);
    }
    written.push({ database, filepath, size });
    logger.info({ database, filepath, sizeKB: (size / 1024).toFixed(1) }, 'Pre-migration dump written');
  }

  rotateSets(BACKUP_DIR, KEEP);
  return { skipped: false, dir: setDir, files: written };
}

if (require.main === module) {
  preMigrationBackup()
    .then((result) => {
      if (!result.skipped) {
        console.log(`Pre-migration backup: ${result.dir}`);
        for (const f of result.files) {
          console.log(`  ${f.database}: ${f.filepath}`);
          console.log(`    restore: gunzip -c ${f.filepath} | mysql -u <user> -p ${f.database}`);
        }
      }
      return db.close().finally(() => process.exit(0));
    })
    .catch((err) => {
      logger.error({ err }, 'Pre-migration backup FAILED — not migrating');
      console.error(`error: pre-migration backup failed: ${err.message}`);
      return db.close().catch(() => {}).finally(() => process.exit(1));
    });
}

module.exports = { preMigrationBackup, rotateSets, SET_PREFIX };
